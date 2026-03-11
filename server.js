const express = require('express');
const path    = require('path');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3000;
const APP_TOKEN = process.env.SOCRATA_APP_TOKEN || '';
const SODA_HOST = 'datacatalog.cookcountyil.gov';

// Cache discovered column maps per dataset
const schemaCache = {};

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
  const headers = { 'Accept': 'application/json' };
  if (APP_TOKEN) headers['X-App-Token'] = APP_TOKEN;
  return new Promise((resolve, reject) => {
    const req = https.get({ host: SODA_HOST, path: pathname + '?' + qs, headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200)
          return reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 400)));
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Fetch one row and return all its keys so we can map columns
async function discoverSchema(resource) {
  if (schemaCache[resource]) return schemaCache[resource];
  const rows = await sodaGet(`/resource/${resource}.json`, { '$limit': '1' });
  const keys = (rows && rows.length) ? Object.keys(rows[0]) : [];
  schemaCache[resource] = keys;
  console.log(`[${resource}] columns:`, keys.join(', '));
  return keys;
}

// Find the best matching column name from a list of candidates
function pick(keys, ...candidates) {
  for (const c of candidates) {
    const found = keys.find(k => k.toLowerCase() === c.toLowerCase());
    if (found) return found;
  }
  // Fuzzy: find any key containing the first candidate word
  const word = candidates[0].replace(/[_-]/g, '').toLowerCase();
  return keys.find(k => k.replace(/[_-]/g, '').toLowerCase().includes(word)) || null;
}

app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// Debug endpoint: show live column names for all 3 datasets
app.get('/api/schema', async (req, res) => {
  try {
    const [asr, chars, addr] = await Promise.all([
      discoverSchema('uzyt-m557'),
      discoverSchema('x54s-btds'),
      discoverSchema('3723-97qp')
    ]);
    res.json({ assessor: asr, characteristics: chars, address: addr });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
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
    // Discover all column names in parallel
    const [asrKeys, charsKeys, addrKeys] = await Promise.all([
      discoverSchema('uzyt-m557'),
      discoverSchema('x54s-btds'),
      discoverSchema('3723-97qp')
    ]);

    // Map each dataset's year column
    const asrYr   = pick(asrKeys,   'tax_year', 'year', 'taxyear');
    const charsYr = pick(charsKeys, 'tax_year', 'year', 'taxyear');
    const addrYr  = pick(addrKeys,  'tax_year', 'year', 'taxyear');

    // Map assessor columns
    const asrClass  = pick(asrKeys, 'class', 'property_class', 'class_code');
    const asrNbhd   = pick(asrKeys, 'neighborhood_code', 'nbhd', 'nbhd_code', 'neighborhood');
    const asrBldg   = pick(asrKeys, 'certified_bldg', 'bldg', 'certified_building', 'assessed_bldg');
    const asrLand   = pick(asrKeys, 'certified_land', 'land', 'assessed_land');
    const asrTot    = pick(asrKeys, 'certified_tot', 'tot', 'certified_total', 'assessed_tot', 'assessed_total');

    // Map characteristics columns
    const chYrBuilt = pick(charsKeys, 'year_built', 'yearbuilt', 'yr_built');
    const chBldgSqft= pick(charsKeys, 'building_sqft', 'bldg_sqft', 'sqft_bldg', 'living_area');
    const chLandSqft= pick(charsKeys, 'land_sqft', 'lot_sqft', 'sqft_land');
    const chFullBath= pick(charsKeys, 'num_full_baths', 'full_baths', 'num_fullbaths', 'baths_full');
    const chHalfBath= pick(charsKeys, 'num_half_baths', 'half_baths', 'num_halfbaths', 'baths_half');
    const chFP      = pick(charsKeys, 'num_fireplaces', 'fireplaces', 'fireplace');
    const chType    = pick(charsKeys, 'type_of_residence', 'residence_type', 'type_residence', 'design');
    const chExt     = pick(charsKeys, 'ext_wall_material', 'exterior_wall', 'ext_wall', 'exterior');
    const chUnits   = pick(charsKeys, 'num_apartments', 'apartments', 'units', 'num_units');
    const chGarage  = pick(charsKeys, 'garage_size', 'garage', 'garage_spaces');
    const chBsmt    = pick(charsKeys, 'basement_type', 'basement', 'bsmt_type');
    const chAC      = pick(charsKeys, 'central_air', 'air_conditioning', 'ac', 'central_ac');

    // Map address columns
    const addrStreet= pick(addrKeys, 'property_address', 'address', 'street_address', 'situs_address');
    const addrCity  = pick(addrKeys, 'property_city', 'city', 'situs_city');

    // Build select lists (only include non-null columns)
    const asrSelect = ['pin', asrYr, asrClass, asrNbhd, asrBldg, asrLand, asrTot]
      .filter(Boolean).join(',');
    const charsSelect = ['pin', charsYr, chYrBuilt, chBldgSqft, chLandSqft,
      chFullBath, chHalfBath, chFP, chType, chExt, chUnits, chGarage, chBsmt, chAC]
      .filter(Boolean).join(',');
    const addrSelect = ['pin', addrYr, addrStreet, addrCity].filter(Boolean).join(',');

    const whereAsr   = `${pinClause} AND ${asrYr}   = '${yr}'`;
    const whereChars = `${pinClause} AND ${charsYr} = '${yr}'`;
    const whereAddr  = `${pinClause} AND ${addrYr}  = '${yr}'`;

    const [asrR, charsR, addrR] = await Promise.all([
      sodaGet('/resource/uzyt-m557.json', { '$where': whereAsr,   '$select': asrSelect,   '$limit': '1' })
        .catch(e => ({ _err: e.message })),
      sodaGet('/resource/x54s-btds.json', { '$where': whereChars, '$select': charsSelect, '$limit': '1' })
        .catch(e => ({ _err: e.message })),
      sodaGet('/resource/3723-97qp.json', { '$where': whereAddr,  '$select': addrSelect,  '$limit': '1' })
        .catch(e => ({ _err: e.message }))
    ]);

    // Normalize response: remap whatever column names came back to our standard names
    function normalize(row, map) {
      if (!row) return null;
      const out = {};
      for (const [std, actual] of Object.entries(map)) {
        if (actual && row[actual] !== undefined) out[std] = row[actual];
      }
      return out;
    }

    const asrRow   = Array.isArray(asrR)   ? asrR[0]   : null;
    const charsRow = Array.isArray(charsR) ? charsR[0] : null;
    const addrRow  = Array.isArray(addrR)  ? addrR[0]  : null;

    const asr = normalize(asrRow, {
      pin: 'pin', tax_year: asrYr, class: asrClass,
      neighborhood_code: asrNbhd, certified_bldg: asrBldg,
      certified_land: asrLand, certified_tot: asrTot
    });
    const chars = normalize(charsRow, {
      pin: 'pin', tax_year: charsYr, year_built: chYrBuilt,
      building_sqft: chBldgSqft, land_sqft: chLandSqft,
      num_full_baths: chFullBath, num_half_baths: chHalfBath,
      num_fireplaces: chFP, type_of_residence: chType,
      ext_wall_material: chExt, num_apartments: chUnits,
      garage_size: chGarage, basement_type: chBsmt, central_air: chAC
    });
    const addr = normalize(addrRow, {
      pin: 'pin', tax_year: addrYr,
      property_address: addrStreet, property_city: addrCity
    });

    res.json({
      pin: pin14, year: yr, asr, chars, addr,
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
