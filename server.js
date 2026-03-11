const express = require('express');
const path    = require('path');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;

// Optional: set SOCRATA_APP_TOKEN env var in Railway for higher rate limits
// Get a free token at https://datacatalog.cookcountyil.gov/profile/app_tokens
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || '';

const SODA_HOST = 'datacatalog.cookcountyil.gov';

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
          return reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 300)));
        }
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/api/pin/:pin', async (req, res) => {
  const yr    = (req.query.year || '').trim();
  if (!yr || !/^\d{4}$/.test(yr))
    return res.status(400).json({ error: 'Missing ?year=YYYY' });

  const pin14 = pad14(req.params.pin);
  const pStrip = pin14.replace(/^0+/, '') || pin14;
  const dashed = dashPIN(pin14);

  const pinClause = pStrip === pin14
    ? `pin = '${pin14}'`
    : `(pin = '${pin14}' OR pin = '${pStrip}')`;
  const whereMain = `${pinClause} AND tax_year = '${yr}'`;
  const addrPinClause = pStrip === pin14
    ? `pin = '${pin14}'`
    : `(pin = '${pin14}' OR pin = '${pStrip}')`;
  const whereAddr = `${addrPinClause} AND tax_year = '${yr}'`;

  try {
    const [asrR, charsR, addrR] = await Promise.all([
      sodaGet('/resource/uzyt-m557.json', {
        '$where':  whereMain,
        '$select': 'pin,tax_year,class,neighborhood_code,certified_bldg,certified_land,certified_tot',
        '$limit':  '1'
      }).catch(e => ({ _err: e.message })),

      sodaGet('/resource/x54s-btds.json', {
        '$where':  whereMain,
        '$select': 'pin,tax_year,year_built,building_sqft,land_sqft,num_full_baths,num_half_baths,num_fireplaces,type_of_residence,ext_wall_material,num_apartments,garage_size,basement_type,central_air',
        '$limit':  '1'
      }).catch(e => ({ _err: e.message })),

      sodaGet('/resource/3723-97qp.json', {
        '$where':  whereAddr,
        '$select': 'pin,tax_year,property_address,property_city',
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
        asr:   asrR._err   || null,
        chars: charsR._err || null,
        addr:  addrR._err  || null
      }
    });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.listen(PORT, () => console.log('PTAB server on port ' + PORT));
