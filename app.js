const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const addressEl = document.getElementById("address");
const radiusEl = document.getElementById("radiusKm");
const programScopeEl = document.getElementById("programScope");
const dropinOnlyEl = document.getElementById("dropinOnly");
const activityTypeFilterEl = document.getElementById("activityTypeFilter");
const programDateEl = document.getElementById("programDate");
const startTimeEl = document.getElementById("startTime");
const endTimeEl = document.getElementById("endTime");
const activityFilterEl = document.getElementById("activityFilter");
const kidOnlyEl = document.getElementById("kidOnly");
const searchBtn = document.getElementById("searchBtn");

const map = L.map("map").setView([43.6532, -79.3832], 11);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap",
}).addTo(map);

let data = null;
let userMarker = null;
let radiusCircle = null;
const markersLayer = L.layerGroup().addTo(map);

const setStatus = (msg) => (statusEl.textContent = msg);
const esc = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

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
function parseInputMin(v) {
  if (!v) return null;
  const [h, m] = String(v).split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}
function scopeOf(p) {
  return p?.source === "registered" ? "registered" : "dropin";
}
function effectiveScope() {
  if (dropinOnlyEl.checked) return "dropin";
  return programScopeEl.value || "all";
}
function activityTypeOf(p) {
  return String(p.activityType || "Other");
}

function selectedActivities() {
  return new Set(
    Array.from(activityFilterEl.selectedOptions).map((o) =>
      String(o.value).trim().toLowerCase()
    )
  );
}

function populateActivityTypes(scope) {
  activityTypeFilterEl.innerHTML = '<option value="all">All activity types</option>';
  const set = new Set();
  for (const f of data.facilities) {
    for (const p of f.programs) {
      if (scope !== "all" && scopeOf(p) !== scope) continue;
      set.add(activityTypeOf(p));
    }
  }
  for (const t of Array.from(set).sort((a, b) => a.localeCompare(b))) {
    const opt = document.createElement("option");
    opt.value = t.toLowerCase();
    opt.textContent = t;
    activityTypeFilterEl.appendChild(opt);
  }
}

function populateActivities(scope, selectedType) {
  activityFilterEl.innerHTML = "";
  const set = new Set();
  for (const f of data.facilities) {
    for (const p of f.programs) {
      if (scope !== "all" && scopeOf(p) !== scope) continue;
      if (
        selectedType !== "all" &&
        activityTypeOf(p).toLowerCase() !== selectedType
      ) {
        continue;
      }
      const n = String(p.activity || "").trim();
      if (n) set.add(n);
    }
  }
  for (const a of Array.from(set).sort((x, y) => x.localeCompare(y))) {
    const opt = document.createElement("option");
    opt.value = a;
    opt.textContent = a;
    activityFilterEl.appendChild(opt);
  }
}

function refreshDropdowns() {
  if (!data) return;
  const scope = effectiveScope();
  const prevType = activityTypeFilterEl.value || "all";
  populateActivityTypes(scope);
  if (Array.from(activityTypeFilterEl.options).some((o) => o.value === prevType)) {
    activityTypeFilterEl.value = prevType;
  }
  populateActivities(scope, activityTypeFilterEl.value || "all");
}

function formatProgram(p) {
  const dateText = p.date || p.dateLabel || `${p.startDate || ""} to ${p.endDate || ""}`;
  return `${dateText} | ${p.time} | ${p.activity} (${p.age || "All ages"})`;
}

function filterPrograms(programs, opts) {
  return programs.filter((p) => {
    if (opts.scope !== "all" && scopeOf(p) !== opts.scope) return false;
    if (
      opts.activityType !== "all" &&
      activityTypeOf(p).toLowerCase() !== opts.activityType
    ) {
      return false;
    }
    const activityNorm = String(p.activity || "").trim().toLowerCase();
    if (opts.activities.size > 0 && !opts.activities.has(activityNorm)) return false;
    if (opts.date) {
      if (p.date) {
        if (p.date !== opts.date) return false;
      } else if (p.startDate && p.endDate) {
        if (!(opts.date >= p.startDate && opts.date <= p.endDate)) return false;
      } else return false;
    }
    if (opts.kidOnly && scopeOf(p) === "registered") return false;
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
  resultsEl.innerHTML = facilities
    .map((f) => {
      const items = f.matchingPrograms
        .slice(0, 8)
        .map((p) => `<li>${esc(formatProgram(p))}</li>`)
        .join("");
      const popupItems = f.matchingPrograms
        .slice(0, 4)
        .map((p) => `<li>${esc(formatProgram(p))}</li>`)
        .join("");
      L.marker([f.lat, f.lng])
        .bindPopup(
          `<strong>${esc(f.name)}</strong><br>${esc(f.address)}<br>Distance: ${f.distanceKm.toFixed(
            2
          )} km<ul>${popupItems}</ul>`
        )
        .addTo(markersLayer);
      return `<article class="card"><h3>${esc(f.name)}</h3><p class="meta">${esc(
        f.address
      )} (${f.distanceKm.toFixed(2)} km)</p><p class="meta">${esc(
        f.locationType
      )}</p><p class="meta"><a target="_blank" rel="noopener" href="${esc(
        f.website
      )}">Facility page</a></p><ul class="programs">${items}</ul></article>`;
    })
    .join("");
}

async function geocodeAddress(address) {
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
  const radiusKm = Math.max(1, Math.min(30, Number(radiusEl.value) || 8));
  const opts = {
    scope: effectiveScope(),
    activityType: activityTypeFilterEl.value || "all",
    activities: selectedActivities(),
    date: programDateEl.value || null,
    startMin: parseInputMin(startTimeEl.value),
    endMin: parseInputMin(endTimeEl.value),
    kidOnly: kidOnlyEl.checked,
  };
  if (opts.startMin !== null && opts.endMin !== null && opts.endMin <= opts.startMin) {
    return setStatus("End time must be after start time.");
  }

  setStatus("Finding your address...");
  try {
    const pos = await geocodeAddress(address);
    const facilities = data.facilities
      .map((f) => ({
        ...f,
        distanceKm: haversineKm(pos.lat, pos.lng, f.lat, f.lng),
        matchingPrograms: filterPrograms(
          opts.kidOnly ? f.kidPrograms || [] : f.programs || [],
          opts
        ),
      }))
      .filter((f) => Number.isFinite(f.distanceKm) && f.distanceKm <= radiusKm && f.matchingPrograms.length > 0)
      .sort((a, b) => a.distanceKm - b.distanceKm);

    render(facilities);
    if (userMarker) map.removeLayer(userMarker);
    if (radiusCircle) map.removeLayer(radiusCircle);
    userMarker = L.marker([pos.lat, pos.lng]).addTo(map).bindPopup("Your address");
    radiusCircle = L.circle([pos.lat, pos.lng], {
      radius: radiusKm * 1000,
      color: "#0b5cab",
      fillOpacity: 0.08,
    }).addTo(map);
    const bounds = L.featureGroup([markersLayer, userMarker, radiusCircle]).getBounds();
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.18));
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
  refreshDropdowns();
  const swimCount = data?.stats?.swimFacilitiesWithPrograms ?? data?.stats?.locationsWithPrograms;
  const regCount = data?.stats?.registeredFacilitiesWithPrograms;
  const totalCount = data?.stats?.totalFacilitiesCombined ?? data?.facilities?.length;
  if (Number.isFinite(swimCount) && Number.isFinite(regCount) && Number.isFinite(totalCount)) {
    setStatus(`Loaded ${totalCount} facilities (${swimCount} swim, ${regCount} registered).`);
  } else {
    setStatus(`Loaded ${data.facilities.length} facilities.`);
  }
}

searchBtn.addEventListener("click", runSearch);
addressEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runSearch();
});
programScopeEl.addEventListener("change", refreshDropdowns);
dropinOnlyEl.addEventListener("change", refreshDropdowns);
activityTypeFilterEl.addEventListener("change", refreshDropdowns);

loadData().catch((e) => setStatus(`Error: ${e.message}`));
