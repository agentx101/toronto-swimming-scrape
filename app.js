const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const controlsEl = document.getElementById("controls");
const addressEl = document.getElementById("address");
const radiusEl = document.getElementById("radiusKm");
const programScopeEls = document.querySelectorAll('input[name="programScope"]');
const activityPickerBtn = document.getElementById("activityPickerBtn");
const activityPickerLabel = document.getElementById("activityPickerLabel");
const activityPickerPanel = document.getElementById("activityPickerPanel");
const programDateEl = document.getElementById("programDate");
const startHourEl = document.getElementById("startHour");
const startMinuteEl = document.getElementById("startMinute");
const startPeriodEl = document.getElementById("startPeriod");
const endHourEl = document.getElementById("endHour");
const endMinuteEl = document.getElementById("endMinute");
const endPeriodEl = document.getElementById("endPeriod");
const addressSuggestionsEl = document.getElementById("addressSuggestions");
const kidOnlyEl = document.getElementById("kidOnly");
const searchBtn = document.getElementById("searchBtn");
const toggleFiltersBtn = document.getElementById("toggleFiltersBtn");

const map = L.map("map").setView([43.6532, -79.3832], 11);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap",
}).addTo(map);
const originMarkerIcon = L.divIcon({
  className: "origin-pin-wrap",
  html: '<span class="origin-pin" aria-hidden="true"></span>',
  iconSize: [30, 40],
  iconAnchor: [15, 40],
  popupAnchor: [0, -40],
});

let data = null;
let userMarker = null;
let radiusCircle = null;
let selectedAddress = null;
let addressSuggestionTimer = null;
const selectedActivityCategories = new Set();
const selectedActivityGroups = new Set();
const selectedActivitySubsets = new Set();
const markersLayer = L.layerGroup().addTo(map);
const TORONTO_ADDRESS_API = "/api/toronto-addresses";

const ACTIVITY_CATEGORIES = [
  { name: "Swimming", icon: "&#8767;" },
  { name: "Sports", icon: "&#9679;" },
  { name: "Arts", icon: "&#9835;" },
  { name: "Fitness", icon: "&#9889;" },
  { name: "General", icon: "&#10022;" },
  { name: "Adapted", icon: "+" },
];

// Avoid searches against an uninitialized data set while the JSON is loading.
searchBtn.disabled = true;

const setStatus = (msg) => (statusEl.textContent = msg);
function setFiltersCollapsed(collapsed) {
  controlsEl.classList.toggle("filters-collapsed", collapsed);
  toggleFiltersBtn.textContent = collapsed ? "More filters" : "Hide filters";
  toggleFiltersBtn.setAttribute("aria-expanded", String(!collapsed));
}
const esc = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function originPopup(address) {
  return `<span class="origin-address">${esc(address)}</span>`;
}

function showAddressSuggestions(matches) {
  addressSuggestionsEl.replaceChildren();
  if (!matches.length) {
    addressSuggestionsEl.hidden = true;
    return;
  }
  for (const match of matches) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "address-suggestion";
    button.textContent = match.display_name;
    button.addEventListener("click", () => {
      const pos = { lat: Number(match.lat), lng: Number(match.lon) };
      selectedAddress = { address: match.display_name, ...pos };
      addressEl.value = match.display_name;
      addressSuggestionsEl.hidden = true;
      if (userMarker) map.removeLayer(userMarker);
      userMarker = L.marker([pos.lat, pos.lng], { icon: originMarkerIcon }).addTo(map).bindPopup(originPopup(match.display_name));
      map.setView([pos.lat, pos.lng], 14);
      setStatus("Address selected. Choose filters, then search nearby.");
    });
    addressSuggestionsEl.appendChild(button);
  }
  addressSuggestionsEl.hidden = false;
}

function cityAddressMatches(records) {
  return records.flatMap((record) => {
    try {
      const [lng, lat] = JSON.parse(record.geometry).coordinates;
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
      const address = String(record.ADDRESS_FULL || "").trim();
      return address
        ? [{ display_name: `${address}, Toronto, ON`, lat, lon: lng }]
        : [];
    } catch {
      return [];
    }
  });
}

async function findTorontoAddresses(query, limit = 5) {
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
  });
  const res = await fetch(`${TORONTO_ADDRESS_API}?${params}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Toronto address lookup failed (${res.status})`);
  const payload = await res.json();
  if (!payload?.success) throw new Error("Toronto address lookup failed");
  return cityAddressMatches(payload.result?.records || []);
}

async function loadAddressSuggestions(query) {
  if (query.length < 3) return showAddressSuggestions([]);
  try {
    const torontoMatches = await findTorontoAddresses(query);
    if (torontoMatches.length) return showAddressSuggestions(torontoMatches);
  } catch {
    // Continue with the broad Canadian geocoder if the City service is unavailable.
  }

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=ca&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) return showAddressSuggestions([]);
    const matches = await res.json();
    showAddressSuggestions(
      Array.isArray(matches)
        ? matches.filter((match) => String(match.display_name || "").toLowerCase().includes("toronto"))
        : []
    );
  } catch {
    showAddressSuggestions([]);
  }
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (n) => (n * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parse12hToMin(t) {
  const m = String(t).trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const mm = Number(m[2]);
  const p = m[3].toUpperCase();
  if (h === 12) h = 0;
  if (p === "PM") h += 12;
  return h * 60 + mm;
}
function parseProgramRange(timeText) {
  const parts = String(timeText).split("-").map((x) => x.trim());
  if (parts.length !== 2) return null;
  const s = parse12hToMin(parts[0]);
  const e = parse12hToMin(parts[1]);
  if (s === null || e === null) return null;
  return { start: s, end: e };
}
function torontoDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  return Object.fromEntries(
    parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value])
  );
}

function torontoDateString(now = new Date()) {
  const parts = torontoDateParts(now);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function timeSelectMinutes(hourEl, minuteEl, periodEl) {
  let hour = Number(hourEl.value);
  const minute = Number(minuteEl.value);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour === 12) hour = 0;
  if (periodEl.value === "PM") hour += 12;
  return hour * 60 + minute;
}

function setTimeSelects(hourEl, minuteEl, periodEl, minutes) {
  const safeMinutes = Math.max(0, Math.min(23 * 60 + 59, minutes));
  const hour24 = Math.floor(safeMinutes / 60);
  hourEl.value = String((hour24 % 12) || 12);
  minuteEl.value = String(safeMinutes % 60).padStart(2, "0");
  periodEl.value = hour24 >= 12 ? "PM" : "AM";
}

function populateTimeSelects(hourEl, minuteEl, periodEl) {
  hourEl.innerHTML = Array.from({ length: 12 }, (_, index) => `<option value="${index + 1}">${index + 1}</option>`).join("");
  minuteEl.innerHTML = Array.from({ length: 60 }, (_, index) => `<option value="${String(index).padStart(2, "0")}">${String(index).padStart(2, "0")}</option>`).join("");
  periodEl.innerHTML = '<option value="AM">AM</option><option value="PM">PM</option>';
}
function scopeOf(p) {
  return p?.source === "registered" ? "registered" : "dropin";
}
function effectiveScope() {
  return document.querySelector('input[name="programScope"]:checked')?.value || "dropin";
}
function activityTypeOf(p) {
  return String(p.activityType || "Other");
}

function activityCategoryOf(p) {
  const type = activityTypeOf(p).toLowerCase();
  const category = String(p.category || "").toLowerCase();
  const activity = String(p.activity || "").toLowerCase();
  if (/adapted/.test(type) || /adapted/.test(category) || /adapted/.test(activity)) return "Adapted";
  if (/swim/.test(type) || /swimming/.test(category) || /swim/.test(activity)) return "Swimming";
  if (/fitness|cardio|conditioning|pilates|tai chi|yoga/.test(type) || /fitness/.test(category)) return "Fitness";
  if (/art|dance|drama|music|cooking|gardening/.test(type) || /arts/.test(category)) return "Arts";
  if (/sport|skating|hockey|soccer|basketball|volleyball|golf|racquet/.test(type) || /sports|skating|ski/.test(category) || /skate/.test(activity)) return "Sports";
  return "General";
}

function activityGroupOf(p) {
  if (p.source === "registered") return activityTypeOf(p);
  const activity = String(p.activity || "Other").trim();
  const prefix = activity.split(":")[0].replace(/\s*\([^)]*\)\s*$/, "").trim();
  return prefix || "Other";
}

function activitySubsetOf(p) {
  return String(p.activity || activityTypeOf(p) || "Other");
}

function activityGroupKey(category, group) {
  return `${category}\u001f${group}`;
}

function activitySubsetKey(category, group, subset) {
  return `${category}\u001f${group}\u001f${subset}`;
}

function activityCatalog(scope) {
  const catalog = new Map(ACTIVITY_CATEGORIES.map(({ name }) => [name, new Map()]));
  for (const facility of data?.facilities || []) {
    for (const program of facility.programs || []) {
      if (scope !== "all" && scopeOf(program) !== scope) continue;
      const category = activityCategoryOf(program);
      const group = activityGroupOf(program);
      if (!catalog.get(category).has(group)) catalog.get(category).set(group, new Set());
      catalog.get(category).get(group).add(activitySubsetOf(program));
    }
  }
  return catalog;
}

function updateActivityPickerLabel() {
  if (!selectedActivityCategories.size) {
    activityPickerLabel.textContent = "All activities";
  } else if (selectedActivitySubsets.size) {
    activityPickerLabel.textContent = `${selectedActivitySubsets.size} selected`;
  } else if (selectedActivityGroups.size) {
    activityPickerLabel.textContent = `${selectedActivityGroups.size} groups`;
  } else {
    activityPickerLabel.textContent = `${selectedActivityCategories.size} categories`;
  }
}

function renderActivityPicker() {
  const catalog = activityCatalog(effectiveScope());
  for (const category of Array.from(selectedActivityCategories)) {
    if (!catalog.get(category)?.size) {
      selectedActivityCategories.delete(category);
      for (const key of Array.from(selectedActivityGroups)) {
        if (key.startsWith(`${category}\u001f`)) selectedActivityGroups.delete(key);
      }
    }
  }
  for (const key of Array.from(selectedActivityGroups)) {
    const [category, group] = key.split("\u001f");
    if (!selectedActivityCategories.has(category) || !catalog.get(category)?.has(group)) {
      selectedActivityGroups.delete(key);
    }
  }
  for (const key of Array.from(selectedActivitySubsets)) {
    const [category, group, subset] = key.split("\u001f");
    if (!selectedActivityGroups.has(activityGroupKey(category, group)) || !catalog.get(category)?.get(group)?.has(subset)) {
      selectedActivitySubsets.delete(key);
    }
  }
  activityPickerPanel.innerHTML = ACTIVITY_CATEGORIES.map(({ name, icon }) => {
    const checked = selectedActivityCategories.has(name);
    const groups = Array.from(catalog.get(name) || []).sort(([a], [b]) => a.localeCompare(b));
    const groupControls = checked
      ? `<div class="category-subsets">${groups.map(([group, subsets]) => {
          const groupKey = activityGroupKey(name, group);
          const groupChecked = selectedActivityGroups.has(groupKey);
          const activities = Array.from(subsets).sort((a, b) => a.localeCompare(b));
          const activityControls = groupChecked
            ? `<div class="activity-options">${activities.map((subset) => {
                const key = activitySubsetKey(name, group, subset);
                return `<label class="subset-check"><input type="checkbox" data-subset-category="${esc(name)}" data-subset-group="${esc(group)}" data-subset="${esc(subset)}" ${selectedActivitySubsets.has(key) ? "checked" : ""} />${esc(subset)}</label>`;
              }).join("")}</div>`
            : "";
          return `<div class="group-option"><label class="group-check"><input type="checkbox" data-group-category="${esc(name)}" data-group="${esc(group)}" ${groupChecked ? "checked" : ""} />${esc(group)}</label>${activityControls}</div>`;
        }).join("")}</div>`
      : "";
    return `<div class="category-option"><label class="category-check"><input type="checkbox" data-category="${esc(name)}" ${checked ? "checked" : ""} /><span class="category-icon" aria-hidden="true">${icon}</span>${esc(name)}</label>${groupControls}</div>`;
  }).join("");
  updateActivityPickerLabel();
}

function isKidFriendlyProgram(p) {
  const age = String(p.age || "").toLowerCase();
  const activity = String(p.activity || "").toLowerCase();
  if (/all\s*ages|family|caregiver|preschool|toddler|early years|child|children/.test(age) ||
      /family|caregiver|preschool|toddler|early years|child|children/.test(activity)) {
    return true;
  }
  const ages = age.match(/\d+/g)?.map(Number) ?? [];
  if (!ages.length) return false;
  if (age.includes("and over")) return ages[0] < 13;
  return ages[0] < 13;
}

function nextTorontoDate(dateString) {
  const date = new Date(`${dateString}T12:00:00`);
  date.setDate(date.getDate() + 1);
  return date.toISOString().slice(0, 10);
}

function disableEarlierTimeOptions(hourEl, minuteEl, periodEl, minimum) {
  const selectedPeriod = periodEl.value;
  for (const option of hourEl.options) {
    let hour = Number(option.value);
    if (hour === 12) hour = 0;
    if (selectedPeriod === "PM") hour += 12;
    option.disabled = hour * 60 + 59 < minimum;
  }

  const selectedHour = timeSelectMinutes(hourEl, minuteEl, periodEl);
  for (const option of minuteEl.options) {
    const candidate = selectedHour - Number(minuteEl.value) + Number(option.value);
    option.disabled = candidate < minimum;
  }
}

function updateTimeAvailability() {
  const now = torontoDateParts();
  const hour = Number(now.hour);
  const minute = Number(now.minute);
  const currentDate = torontoDateString();
  const minimumToday = Math.min(23 * 60 + 59, (hour + (minute > 0 ? 1 : 0)) * 60);
  const isToday = programDateEl.value === currentDate;

  for (const select of [startHourEl, startMinuteEl, startPeriodEl, endHourEl, endMinuteEl, endPeriodEl]) {
    for (const option of select.options) option.disabled = false;
  }

  if (!isToday) return;
  if (timeSelectMinutes(startHourEl, startMinuteEl, startPeriodEl) < minimumToday) {
    setTimeSelects(startHourEl, startMinuteEl, startPeriodEl, minimumToday);
  }
  disableEarlierTimeOptions(startHourEl, startMinuteEl, startPeriodEl, minimumToday);

  const minimumEnd = Math.min(23 * 60 + 59, timeSelectMinutes(startHourEl, startMinuteEl, startPeriodEl) + 1);
  if (timeSelectMinutes(endHourEl, endMinuteEl, endPeriodEl) < minimumEnd) {
    setTimeSelects(endHourEl, endMinuteEl, endPeriodEl, minimumEnd);
  }
  disableEarlierTimeOptions(endHourEl, endMinuteEl, endPeriodEl, minimumEnd);
}

function initializeDateAndTimeControls() {
  for (const selects of [
    [startHourEl, startMinuteEl, startPeriodEl],
    [endHourEl, endMinuteEl, endPeriodEl],
  ]) {
    populateTimeSelects(...selects);
  }

  const now = torontoDateParts();
  const currentDate = torontoDateString();
  const hour = Number(now.hour);
  const defaultDate = hour >= 18 ? nextTorontoDate(currentDate) : currentDate;
  const defaultStart = 9 * 60;

  programDateEl.min = currentDate;
  programDateEl.value = defaultDate;
  setTimeSelects(startHourEl, startMinuteEl, startPeriodEl, defaultStart);
  setTimeSelects(endHourEl, endMinuteEl, endPeriodEl, 23 * 60);
  updateTimeAvailability();
}

function refreshDropdowns() {
  if (!data) return;
  renderActivityPicker();
}

function formatProgram(p) {
  const dateText = p.date || p.dateLabel || `${p.startDate || ""} to ${p.endDate || ""}`;
  return `${dateText} | ${p.time} | ${p.activity} (${p.age || "All ages"})`;
}

function filterPrograms(programs, opts) {
  return programs.filter((p) => {
    if (opts.scope !== "all" && scopeOf(p) !== opts.scope) return false;
    const category = activityCategoryOf(p);
    if (opts.categories.size && !opts.categories.has(category)) return false;
    const group = activityGroupOf(p);
    const groupKey = activityGroupKey(category, group);
    const groupsInCategory = Array.from(opts.groups).filter((key) => key.startsWith(`${category}\u001f`));
    if (groupsInCategory.length && !opts.groups.has(groupKey)) return false;
    const selectedSubsets = Array.from(opts.subsets).filter((key) => key.startsWith(`${groupKey}\u001f`));
    if (selectedSubsets.length && !opts.subsets.has(activitySubsetKey(category, group, activitySubsetOf(p)))) {
      return false;
    }
    if (opts.date) {
      if (p.date) {
        if (p.date !== opts.date) return false;
      } else if (p.startDate && p.endDate) {
        if (!(opts.date >= p.startDate && opts.date <= p.endDate)) return false;
      } else return false;
    }
    if (opts.kidOnly && !isKidFriendlyProgram(p)) return false;
    if (opts.startMin !== null || opts.endMin !== null) {
      const r = parseProgramRange(p.time);
      if (!r) return false;
      const ws = opts.startMin ?? 0;
      const we = opts.endMin ?? 24 * 60;
      if (!(r.start < we && r.end > ws)) return false;
    }
    return true;
  });
}

function render(facilities) {
  markersLayer.clearLayers();
  if (!facilities.length) {
    resultsEl.innerHTML = "<p>No nearby facilities found for those filters.</p>";
    return;
  }

  const activityGroups = new Map();
  for (const facility of facilities) {
    const navigateUrl = directionsUrl(facility);
    const popupItems = facility.matchingPrograms
      .slice(0, 4)
      .map((p) => `<li>${esc(formatProgram(p))}</li>`)
      .join("");
    L.marker([facility.lat, facility.lng])
      .bindPopup(
        `<strong>${esc(facility.name)}</strong><br>${esc(facility.address)}<br>Distance: ${facility.distanceKm.toFixed(
          2
        )} km<ul>${popupItems}</ul><div class="map-popup-actions"><a class="map-navigate-button" target="_blank" rel="noopener" href="${esc(navigateUrl)}">Navigate</a><a class="facility-link" target="_blank" rel="noopener" href="${esc(facility.website)}" aria-label="Open facility page" title="Facility page">&#8599;</a></div>`
      )
      .addTo(markersLayer);

    for (const program of facility.matchingPrograms) {
      const activity = String(program.activity || "Other activities");
      if (!activityGroups.has(activity)) activityGroups.set(activity, []);
      activityGroups.get(activity).push({ facility, program });
    }
  }

  const programStart = ({ program }) => {
    const range = parseProgramRange(program.time);
    const date = program.date || program.startDate || "9999-12-31";
    return `${date}|${String(range?.start ?? 24 * 60).padStart(4, "0")}`;
  };
  const groups = Array.from(activityGroups, ([activity, sessions]) => ({
    activity,
    sessions: sessions.sort((a, b) => programStart(a).localeCompare(programStart(b))),
  })).sort((a, b) => programStart(a.sessions[0]).localeCompare(programStart(b.sessions[0])));

  resultsEl.innerHTML = groups
    .map(({ activity, sessions }) => {
      const rows = sessions
        .map(({ facility, program }) => {
          const date = program.date || program.dateLabel || "Scheduled dates";
          const location = `${facility.name} (${facility.distanceKm.toFixed(1)} km)`;
          return `<article class="session-row"><span class="session-time">${esc(program.time || "Time TBA")}</span><span class="session-place"><strong>${esc(
            location
          )}</strong><small>${esc(facility.address)} | ${esc(date)}</small></span><span class="session-actions"><a class="facility-link" target="_blank" rel="noopener" href="${esc(
            facility.website
          )}" aria-label="Open facility page" title="Facility page">&#8599;</a><a class="navigate-button" target="_blank" rel="noopener" href="${esc(directionsUrl(facility))}">Navigate</a></span></article>`;
        })
        .join("");
      return `<section class="activity-group"><h3>${esc(activity)}</h3><div class="session-list">${rows}</div></section>`;
    })
    .join("");
}

function directionsUrl(facility) {
  const origin = addressEl.value.trim();
  const destination = `${facility.lat},${facility.lng}`;
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}`;
}

async function geocodeAddress(address) {
  if (selectedAddress?.address === address) {
    return { lat: selectedAddress.lat, lng: selectedAddress.lng };
  }
  try {
    const matches = await findTorontoAddresses(address, 1);
    if (matches.length) return { lat: Number(matches[0].lat), lng: Number(matches[0].lon) };
  } catch {
    // Addresses outside Toronto can still be resolved by the fallback service.
  }
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(
    address
  )}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
  const arr = await res.json();
  if (!arr.length) throw new Error("Address not found");
  return { lat: Number(arr[0].lat), lng: Number(arr[0].lon) };
}

async function runSearch() {
  const address = addressEl.value.trim();
  if (!address) return setStatus("Please enter an address.");
  if (!data || !Array.isArray(data.facilities)) {
    return setStatus("Program data is still loading. Please try again in a moment.");
  }
  const radiusKm = Math.max(1, Math.min(30, Number(radiusEl.value) || 8));
  updateTimeAvailability();
  const opts = {
    scope: effectiveScope(),
    categories: new Set(selectedActivityCategories),
    groups: new Set(selectedActivityGroups),
    subsets: new Set(selectedActivitySubsets),
    date: programDateEl.value || null,
    startMin: timeSelectMinutes(startHourEl, startMinuteEl, startPeriodEl),
    endMin: timeSelectMinutes(endHourEl, endMinuteEl, endPeriodEl),
    kidOnly: kidOnlyEl.checked,
  };
  if (opts.startMin !== null && opts.endMin !== null && opts.endMin <= opts.startMin) {
    return setStatus("End time must be after start time.");
  }
  if (opts.date && opts.date < torontoDateString()) {
    return setStatus("Please choose today or a future date.");
  }
  setStatus("Finding your address...");
  try {
    const pos = await geocodeAddress(address);
    addressSuggestionsEl.hidden = true;
    const facilities = data.facilities
      .map((f) => ({
        ...f,
        distanceKm: haversineKm(pos.lat, pos.lng, f.lat, f.lng),
        matchingPrograms: filterPrograms(f.programs || [], opts),
      }))
      .filter((f) => Number.isFinite(f.distanceKm) && f.distanceKm <= radiusKm && f.matchingPrograms.length > 0)
      .sort((a, b) => a.distanceKm - b.distanceKm);

    render(facilities);
    if (userMarker) map.removeLayer(userMarker);
    if (radiusCircle) map.removeLayer(radiusCircle);
    userMarker = L.marker([pos.lat, pos.lng], { icon: originMarkerIcon }).addTo(map).bindPopup(originPopup(address));
    radiusCircle = L.circle([pos.lat, pos.lng], {
      radius: radiusKm * 1000,
      color: "#0b5cab",
      fillOpacity: 0.08,
    }).addTo(map);
    // The search radius contains both the address and every displayed facility.
    // Do not pass the LayerGroup to FeatureGroup: it has no getLatLng method.
    const bounds = radiusCircle.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.18));
    document.getElementById("map").scrollIntoView({ behavior: "smooth", block: "start" });
    setStatus(`Found ${facilities.length} facilities within ${radiusKm} km.`);
  } catch (e) {
    setStatus(`Could not find address: ${e.message}`);
  }
}

async function loadData() {
  setStatus("Loading local data...");
  const res = await fetch("./data/swim-young-kids.json");
  if (!res.ok) throw new Error("Missing data/swim-young-kids.json");
  data = await res.json();
  if (!Array.isArray(data?.facilities)) {
    throw new Error("Program data is invalid. Refresh the page and try again.");
  }
  refreshDropdowns();
  const swimCount = data?.stats?.swimFacilitiesWithPrograms ?? data?.stats?.locationsWithPrograms;
  const skateCount = data?.stats?.skatingFacilitiesWithPrograms;
  const regCount = data?.stats?.registeredFacilitiesWithPrograms;
  const totalCount = data?.stats?.totalFacilitiesCombined ?? data?.facilities?.length;
  if (Number.isFinite(swimCount) && Number.isFinite(skateCount) && Number.isFinite(regCount) && Number.isFinite(totalCount)) {
    setStatus(`Loaded ${totalCount} facilities (${swimCount} swim, ${skateCount} skating, ${regCount} registered).`);
  } else {
    setStatus(`Loaded ${data.facilities.length} facilities.`);
  }
  searchBtn.disabled = false;
}

searchBtn.addEventListener("click", runSearch);
toggleFiltersBtn.addEventListener("click", () => {
  setFiltersCollapsed(!controlsEl.classList.contains("filters-collapsed"));
});
addressEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runSearch();
});
addressEl.addEventListener("input", () => {
  selectedAddress = null;
  clearTimeout(addressSuggestionTimer);
  addressSuggestionTimer = setTimeout(() => loadAddressSuggestions(addressEl.value.trim()), 600);
});
addressEl.addEventListener("blur", () => {
  setTimeout(() => { addressSuggestionsEl.hidden = true; }, 150);
});
programScopeEls.forEach((scope) => scope.addEventListener("change", refreshDropdowns));
activityPickerBtn.addEventListener("click", () => {
  const open = activityPickerPanel.hidden;
  activityPickerPanel.hidden = !open;
  activityPickerBtn.setAttribute("aria-expanded", String(open));
});
activityPickerPanel.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const category = target.dataset.category || target.dataset.groupCategory || target.dataset.subsetCategory;
  if (!category) return;
  if (target.dataset.category) {
    if (target.checked) {
      selectedActivityCategories.add(category);
    } else {
      selectedActivityCategories.delete(category);
      for (const key of Array.from(selectedActivityGroups)) {
        if (key.startsWith(`${category}\u001f`)) selectedActivityGroups.delete(key);
      }
      for (const key of Array.from(selectedActivitySubsets)) {
        if (key.startsWith(`${category}\u001f`)) selectedActivitySubsets.delete(key);
      }
    }
  } else if (target.dataset.groupCategory) {
    const groupKey = activityGroupKey(category, target.dataset.group || "");
    if (target.checked) {
      selectedActivityGroups.add(groupKey);
    } else {
      selectedActivityGroups.delete(groupKey);
      for (const key of Array.from(selectedActivitySubsets)) {
        if (key.startsWith(`${groupKey}\u001f`)) selectedActivitySubsets.delete(key);
      }
    }
  } else {
    const key = activitySubsetKey(category, target.dataset.subsetGroup || "", target.dataset.subset || "");
    if (target.checked) selectedActivitySubsets.add(key);
    else selectedActivitySubsets.delete(key);
  }
  renderActivityPicker();
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".activity-picker")) {
    activityPickerPanel.hidden = true;
    activityPickerBtn.setAttribute("aria-expanded", "false");
  }
});
programDateEl.addEventListener("change", updateTimeAvailability);
for (const timeSelect of [startHourEl, startMinuteEl, startPeriodEl, endHourEl, endMinuteEl, endPeriodEl]) {
  timeSelect.addEventListener("change", updateTimeAvailability);
}

initializeDateAndTimeControls();
requestAnimationFrame(() => map.invalidateSize());
window.addEventListener("resize", () => map.invalidateSize());
loadData().catch((e) => {
  searchBtn.disabled = true;
  setStatus(`Error loading program data: ${e.message}`);
});
