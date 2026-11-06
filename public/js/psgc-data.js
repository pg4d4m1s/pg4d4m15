// ═══════════════════════════════════════════════════════════════════
// PGA-DAMIS — Bundled PSGC address data (offline fallback)
//
// WHY THIS FILE EXISTS
//   The registration form normally loads Region → Province → City/Municipality →
//   Barangay from the live PSGC API (https://psgc.gitlab.io/api/). That call can fail
//   (blocked by CSP, DNS/ISP issues, weak mobile signal) and an applicant would be
//   stuck on Step 3. Because nearly all residents live in Aurora, everything needed to
//   reach an Aurora address is bundled here:
//
//        Region III → Aurora → 8 municipalities → 151 barangays
//
//   auth.js → psgcFetchAddr() asks psgcBundled(endpoint) before/after the network call.
//   Anything outside Region III / Aurora still needs the live API.
//
// CODES
//   Codes use the SAME 9-digit format as the live API (e.g. Aurora = 037700000), so
//   bundled and live data can be mixed within one session. psgcNorm9() also accepts the
//   newer 10-digit PSGC form. Barangay codes are local ("<municipality>:<slug>") so a
//   reordered list can never restore a saved draft onto the wrong barangay.
//
// HOW TO UPDATE
//   Aurora's barangay list changes rarely (151 as of the PSA PSGC). If a barangay is
//   renamed/added, edit PSGC_BUNDLED.aurora.barangays below — nothing else needs to change.
//   Set PSGC_PREFER_BUNDLED = false to try the live API first and use this data only
//   when it fails.
// ═══════════════════════════════════════════════════════════════════

// true  → Region III / Aurora lists are served instantly from this file (no network)
// false → live API first (2 short attempts), bundled data only as the fallback
var PSGC_PREFER_BUNDLED = true;

var PSGC_REGION_III = '030000000';
var PSGC_AURORA     = '037700000';

var PSGC_BUNDLED = {
  // All 17 regions, so the Region dropdown is never empty.
  regions: [
    {code:'010000000', name:'Region I (Ilocos Region)'},
    {code:'020000000', name:'Region II (Cagayan Valley)'},
    {code:'030000000', name:'Region III (Central Luzon)'},
    {code:'040000000', name:'Region IV-A (CALABARZON)'},
    {code:'170000000', name:'MIMAROPA Region'},
    {code:'050000000', name:'Region V (Bicol Region)'},
    {code:'060000000', name:'Region VI (Western Visayas)'},
    {code:'070000000', name:'Region VII (Central Visayas)'},
    {code:'080000000', name:'Region VIII (Eastern Visayas)'},
    {code:'090000000', name:'Region IX (Zamboanga Peninsula)'},
    {code:'100000000', name:'Region X (Northern Mindanao)'},
    {code:'110000000', name:'Region XI (Davao Region)'},
    {code:'120000000', name:'Region XII (SOCCSKSARGEN)'},
    {code:'130000000', name:'National Capital Region (NCR)'},
    {code:'140000000', name:'Cordillera Administrative Region (CAR)'},
    {code:'160000000', name:'Region XIII (Caraga)'},
    {code:'190000000', name:'Bangsamoro Autonomous Region in Muslim Mindanao (BARMM)'}
  ],

  // Region III provinces (Aurora's own region) — other regions' provinces need the live API.
  regionIIIProvinces: [
    {code:'030800000', name:'Bataan'},
    {code:'031400000', name:'Bulacan'},
    {code:'034900000', name:'Nueva Ecija'},
    {code:'035400000', name:'Pampanga'},
    {code:'036900000', name:'Tarlac'},
    {code:'037100000', name:'Zambales'},
    {code:'037700000', name:'Aurora'}
  ],

  aurora: {
    municipalities: [
      {code:'037701000', name:'Baler'},
      {code:'037702000', name:'Casiguran'},
      {code:'037703000', name:'Dilasag'},
      {code:'037704000', name:'Dinalungan'},
      {code:'037705000', name:'Dingalan'},
      {code:'037706000', name:'Dipaculao'},
      {code:'037707000', name:'Maria Aurora'},
      {code:'037708000', name:'San Luis'}
    ],
    // municipality code → barangay names (PSA PSGC; 151 total)
    barangays: {
    '037701000': [ // Baler (13)
        'Barangay I (Pob.)',
        'Barangay II (Pob.)',
        'Barangay III (Pob.)',
        'Barangay IV (Pob.)',
        'Barangay V (Pob.)',
        'Buhangin',
        'Calabuanan',
        'Obligacion',
        'Pingit',
        'Reserva',
        'Sabang',
        'Suclayin',
        'Zabali'
    ],
    '037702000': [ // Casiguran (24)
        'Barangay 1 (Pob.)',
        'Barangay 2 (Pob.)',
        'Barangay 3 (Pob.)',
        'Barangay 4 (Pob.)',
        'Barangay 5 (Pob.)',
        'Barangay 6 (Pob.)',
        'Barangay 7 (Pob.)',
        'Barangay 8 (Pob.)',
        'Calabgan',
        'Calangcuasan',
        'Calantas',
        'Culat',
        'Dibet',
        'Esperanza',
        'Lual',
        'Marikit',
        'Tabas',
        'Tinib',
        'Bianuan',
        'Cozo',
        'Dibacong',
        'Ditinagyan',
        'Esteves',
        'San Ildefonso'
    ],
    '037703000': [ // Dilasag (11)
        'Diagyan',
        'Dicabasan',
        'Dilaguidi',
        'Dimaseset',
        'Diniog',
        'Lawang',
        'Maligaya (Pob.)',
        'Manggitahan',
        'Masagana (Pob.)',
        'Ura',
        'Esperanza'
    ],
    '037704000': [ // Dinalungan (9)
        'Abuleg',
        'Zone I (Pob.)',
        'Zone II (Pob.)',
        'Nipoo (Bulo)',
        'Dibaraybay',
        'Ditawini',
        'Mapalad',
        'Paleg',
        'Simbahan'
    ],
    '037705000': [ // Dingalan (11)
        'Aplaya',
        'Butas Na Bato',
        'Cabog (Matawe)',
        'Caragsacan',
        'Davildavilan',
        'Dikapanikian',
        'Ibona',
        'Paltic',
        'Poblacion',
        'Tanawan',
        'Umiray (Malamig)'
    ],
    '037706000': [ // Dipaculao (25)
        'Bayabas',
        'Buenavista',
        'Borlongan',
        'Calaocan',
        'Dianed',
        'Diarabasin',
        'Dibutunan',
        'Dimabuno',
        'Dinadiawan',
        'Ditale',
        'Gupa',
        'Ipil',
        'Laboy',
        'Lipit',
        'Lobbot',
        'Maligaya',
        'Mijares',
        'Mucdol',
        'North Poblacion',
        'Puangi',
        'Salay',
        'Sapangkawayan',
        'South Poblacion',
        'Toytoyan',
        'Diamanen'
    ],
    '037707000': [ // Maria Aurora (40)
        'Alcala',
        'Bagtu',
        'Bangco',
        'Bannawag',
        'Barangay I (Pob.)',
        'Barangay II (Pob.)',
        'Barangay III (Pob.)',
        'Barangay IV (Pob.)',
        'Baubo',
        'Bayanihan',
        'Bazal',
        'Cabituculan East',
        'Cabituculan West',
        'Debucao',
        'Decoliat',
        'Detailen',
        'Diaat',
        'Dialatman',
        'Diaman',
        'Dianawan',
        'Dikildit',
        'Dimanpudso',
        'Diome',
        'Estonilo',
        'Florida',
        'Galintuja',
        'Cadayacan',
        'Malasin',
        'Ponglo',
        'Quirino',
        'Ramada',
        'San Joaquin',
        'San Jose',
        'San Leonardo',
        'Santa Lucia',
        'Santo Tomas',
        'Suguit',
        'Villa Aurora',
        'Wenceslao',
        'San Juan'
    ],
    '037708000': [ // San Luis (18)
        'Bacong',
        'Barangay I (Pob.)',
        'Barangay II (Pob.)',
        'Barangay III (Pob.)',
        'Barangay IV (Pob.)',
        'Dibalo',
        'Dibayabay',
        'Dibut',
        'Dikapinisan',
        'Dimanayat',
        'Diteki',
        'Ditumabo',
        'L. Pimentel',
        'Nonong Senior',
        'Real',
        'San Isidro',
        'San Jose',
        'Zarah'
    ]
    }
  }
};

// "0307700000" (10-digit) or "037700000" (9-digit) → "037700000". '' when not a PSGC code.
function psgcNorm9(code) {
  var d = String(code == null ? '' : code).replace(/\D/g, '');
  if (d.length === 10) d = d.slice(0, 2) + d.slice(3);
  return d.length === 9 ? d : '';
}

function psgcSlug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function psgcCopy(list) {
  // fresh objects every call — callers sort the array and may tag it, so the master data must stay untouched
  return list.map(function (x) { return { code: x.code, name: x.name }; });
}

/**
 * psgcBundled(endpoint) → { list, preferred } | null
 * `endpoint` is the same path auth.js sends to the live API, e.g.
 *   'regions' · 'regions/030000000/provinces' · 'provinces/037700000/cities-municipalities'
 *   · 'cities-municipalities/037701000/barangays'
 * Returns null when nothing is bundled for that endpoint (caller must use the network).
 */
function psgcBundled(endpoint) {
  var m, list = null;
  if (endpoint === 'regions') {
    list = psgcCopy(PSGC_BUNDLED.regions);
  } else if ((m = /^regions\/(\d{9,10})\/provinces$/.exec(endpoint))) {
    if (psgcNorm9(m[1]) === PSGC_REGION_III) list = psgcCopy(PSGC_BUNDLED.regionIIIProvinces);
  } else if ((m = /^provinces\/(\d{9,10})\/cities-municipalities$/.exec(endpoint))) {
    if (psgcNorm9(m[1]) === PSGC_AURORA) list = psgcCopy(PSGC_BUNDLED.aurora.municipalities);
  } else if ((m = /^cities-municipalities\/(\d{9,10})\/barangays$/.exec(endpoint))) {
    var key = psgcNorm9(m[1]), names = PSGC_BUNDLED.aurora.barangays[key];
    if (names) list = names.map(function (n) { return { code: key + ':' + psgcSlug(n), name: n }; });
  }
  return list ? { list: list, preferred: PSGC_PREFER_BUNDLED } : null;
}
