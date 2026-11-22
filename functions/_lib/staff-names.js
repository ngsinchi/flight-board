// Display names for Escort Done messages. No phone numbers.
export const STAFF_NAMES = {
  "1000370": "Karzf",
  "1000382": "Keen",
  "1000431": "Jason",
  "1000557": "Ryan",
  "1000732": "Sai",
  "1000741": "Sin",
  "1000795": "SHING",
  "1001026": "Lun",
  "1001144": "C.Ling",
  "1001247": "David",
  "1001460": "Kuen",
  "1001941": "Wing",
  "1001995": "Eric",
  "1002003": "Tsang",
  "1002092": "Matthew",
  "1002166": "Rex",
  "1002327": "Jimmy",
  "1002530": "Kit",
  "1002846": "Fai",
  "1003004": "Kevin",
  "1003026": "Ken",
  "1003141": "Keung",
  "1003180": "Alex",
  "1003279": "Sammy",
  "1003357": "Wah",
};

export function nameOf(staffId) {
  return STAFF_NAMES[String(staffId || "")] || "";
}
