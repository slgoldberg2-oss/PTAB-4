const express = require('express');
const path    = require('path');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || '';
const SODA_HOST = 'datacatalog.cookcountyil.gov';

// Cache the discovered year column name per dataset
const yearColCache = {};

function pad14(s) {
  s = String(s).replace(/\D/g, '');
  while (s.length < 14) s = '0' + s;
  return s.slice(0, 14);
}

function dashPIN(p) {
  p = pad14(p);
  return p.substr(0,2)+'-'+p.substr(2,2)+'-'+p.substr(4,3)+'-'+p.substr(7,3)+'-'+p.substr(10,4);
}

function sodaGet(pathname, params) {
  const qs = Object.entries(params)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');
  const fullPath = pathname + '?' + qs;
  const headers = { 'Accept': 'application/json' };
  if (APP_TOKEN) headers['X-App-Token'] = APP_TOKEN;

  return new Promise((resolve, reject) => {
    const req = https.get({ host: SODA_HOST, path: fullPath, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 400)));
        }
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Discover the year column name for a dataset by fetching one row
async function getYearCol(resource) {
  if (yearColCache[resource]) return yearColCache[resource];
  try {
    const rows = await sodaGet(`/resource/${resource}.json`, { '$limit': '1' });
    if (rows && rows.length > 0) {
      const keys = Object.keys(rows[0]);
      // Look for any key containing 'year' that isn't year_built
      const col = keys.find(k => k === 'tax_year') ||
                  keys.find(k => k === 'year') ||
                  keys.find(k => /year/i.test(k) && k !== 'year_built');
      if (col) {
        yearColCache[resource] = col;
        console.log(`[${resource}] year column = "${col}"`);
        return col;
      }
    }
  } catch(e) {
    console.error(`Failed to probe ${resource}:`, e.message);
  }
  // Default fallback
  yearColCache[resource] = 'tax_year';
  return 'tax_year';
}

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/api/pin/:pin', async (req, res) => {
  const yr = (req.query.year || '').trim();
  if (!yr || !/^\d{4}$/.test(yr))
    return res.status(400).json({ error: 'Missing ?year=YYYY' });

  const pin14  = pad14(req.params.pin);
  const pStrip = pin14.replace(/^0+/, '') || pin14;

  const pinClause = pStrip === pin14
    ? `pin = '${pin14}'`
    : `(pin = '${pin14}' OR pin = '${pStrip}')`;

  try {
    // Discover year column names in parallel
    const [asrYrCol, charsYrCol, addrYrCol] = await Promise.all([
      getYearCol('uzyt-m557'),
      getYearCol('x54s-btds'),
      getYearCol('3723-97qp')
    ]);

    const whereAsr   = `${pinClause} AND ${asrYrCol}   = '${yr}'`;
    const whereChars = `${pinClause} AND ${charsYrCol} = '${yr}'`;
    const whereAddr  = `${pinClause} AND ${addrYrCol}  = '${yr}'`;

    const [asrR, charsR, addrR] = await Promise.all([
      sodaGet('/resource/uzyt-m557.json', {
        '$where':  whereAsr,
        '$select': `pin,${asrYrCol},class,neighborhood_code,certified_bldg,certified_land,certified_tot`,
        '$limit':  '1'
      }).catch(e => ({ _err: e.message })),

      sodaGet('/resource/x54s-btds.json', {
        '$where':  whereChars,
        '$select': `pin,${charsYrCol},year_built,building_sqft,land_sqft,num_full_baths,num_half_baths,num_fireplaces,type_of_residence,ext_wall_material,num_apartments,garage_size,basement_type,central_air`,
        '$limit':  '1'
      }).catch(e => ({ _err: e.message })),

      sodaGet('/resource/3723-97qp.json', {
        '$where':  whereAddr,
        '$select': `pin,${addrYrCol},property_address,property_city`,
        '$limit':  '1'
      }).catch(e => ({ _err: e.message }))
    ]);

    res.json({
      pin:   pin14,
      year:  yr,
      asr:   Array.isArray(asrR)   ? (asrR[0]   || null) : null,
      chars: Array.isArray(charsR) ? (charsR[0] || null) : null,
      addr:  Array.isArray(addrR)  ? (addrR[0]  || null) : null,
      errors: {
        asr:   (asrR   && asrR._err)   || null,
        chars: (charsR && charsR._err) || null,
        addr:  (addrR  && addrR._err)  || null
      }
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.listen(PORT, () => console.log('PTAB server on port ' + PORT));
