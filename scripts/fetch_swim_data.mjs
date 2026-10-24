#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LOCATION_DATA_URL =
  "https://services3.arcgis.com/b9WvedVPoizGfvfD/arcgis/rest/services/V_Swim_Locations_2022/FeatureServer/0/query?f=json&where=Show_On_Map%20%3D%20%27Yes%27&returnGeometry=true&spatialRel=esriSpatialRelIntersects&outFields=*&outSR=102100&resultOffset=0&resultRecordCount=5000";
const SCHEDULE_BASE_URL = "https://www.toronto.ca/data/parks/live/dropin/swim";
const SKATE_LOCATION_DATA_URL =
  "https://services3.arcgis.com/b9WvedVPoizGfvfD/arcgis/rest/services/Skate_Locations_v2/FeatureServer/0/query?f=json&where=Show_On_Map%20%3D%20%27Yes%27&returnGeometry=true&spatialRel=esriSpatialRelIntersects&outFields=*&outSR=102100&resultOffset=0&resultRecordCount=2000";
const SKATE_SCHEDULE_BASE_URL = "https://www.toronto.ca/data/parks/live/dropin/skate";
const REGAN_SEASON = "Winter";
const REGAN_LOCATIONS_URL = `https://www.toronto.ca/data/parks/prd/regan/${REGAN_SEASON}/locations.json`;
const REGAN_CATEGORY_KEYS = [
  "arts",
  "camps",
  "fitness",
  "general",
  "sports",
  "skating",
  "ski",
  "swimming",
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(ROOT, "data");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "swim-young-kids.json");

function decodeLikelyUtf16(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(buffer.subarray(2));
  }
  if (buffer.length > 8) {
    let nulls = 0;
    const sample = Math.min(buffer.length, 200);
    for (let i = 0; i < sample; i++) {
      if (buffer[i] === 0) nulls++;
    }
    if (nulls / sample > 0.2) {
      return new TextDecoder("utf-16le").decode(buffer);
    }
  }
  return new TextDecoder("utf-8").decode(buffer);
}

function parseAgeRange(ageText) {
  if (!ageText) return null;
  const text = ageText.toLowerCase();
  const numbers = text.match(/\d+/g)?.map(Number) ?? [];
  if (!numbers.length) return null;
  if (text.includes("and over")) return { min: numbers[0], max: Infinity };
  if (numbers.length >= 2) return { min: numbers[0], max: numbers[1] };
  return { min: numbers[0], max: numbers[0] };
}

function isYoungKidsProgram(entry) {
  const activity = (entry.c ?? "").toLowerCase();
  const ageText = entry.age ?? "";
  const ageRange = parseAgeRange(ageText);

  const explicitFamilyLeisureMatch =
    /leisure\s*swim[\s:()\-]*family/i.test(activity);

  const activityMatch =
    /(preschool|family|caregiver|baby|toddler|tot|child|children|parent)/i.test(
      activity
    );

  const ageMatch =
    ageRange !== null &&
    ((ageRange.min <= 5 && ageRange.max >= 3) ||
      (ageRange.min <= 5 && ageRange.max === Infinity));

  return explicitFamilyLeisureMatch || activityMatch || ageMatch;
}

function normalizeScheduleRows(scheduleRows, activityType) {
  const out = [];
  const seen = new Set();

  const startMinutes = (timeText) => {
    const m = String(timeText).match(/^(\d{1,2}):(\d{2})\s*(AM|PM)\s*-/i);
    if (!m) return 0;
    let hour = Number(m[1]);
    const mins = Number(m[2]);
    const period = m[3].toUpperCase();
    if (hour === 12) hour = 0;
    if (period === "PM") hour += 12;
    return hour * 60 + mins;
  };

  for (const row of scheduleRows) {
    const normalized = {
      activity: String(row.c ?? "").trim(),
      age: String(row.age ?? "").trim(),
      date: String(row.d ?? "").trim(),
      time: String(row.t ?? "").trim(),
      facilityArea: String(row.f ?? "").trim(),
      reservable: Boolean(row.res),
      activityType,
      source: "dropin",
    };
    const key = `${normalized.activity}|${normalized.age}|${normalized.date}|${normalized.time}|${normalized.facilityArea}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(normalized);
    }
  }

  out.sort((a, b) => {
    const dateCmp = String(a.date).localeCompare(String(b.date));
    if (dateCmp !== 0) return dateCmp;
    return startMinutes(a.time) - startMinutes(b.time);
  });

  return out;
}

function titleCaseCategory(raw) {
  const s = String(raw || "");
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function parseReganDateRange(text) {
  const m = String(text || "")
    .trim()
    .match(/^([A-Za-z]{3})-(\d{1,2})-(\d{4})\s+to\s+([A-Za-z]{3})-(\d{1,2})-(\d{4})$/);
  if (!m) return { startDate: "", endDate: "", dateLabel: String(text || "") };
  const months = {
    Jan: "01",
    Feb: "02",
    Mar: "03",
    Apr: "04",
    May: "05",
    Jun: "06",
    Jul: "07",
    Aug: "08",
    Sep: "09",
    Oct: "10",
    Nov: "11",
    Dec: "12",
  };
  const startDate = `${m[3]}-${months[m[1]]}-${String(m[2]).padStart(2, "0")}`;
  const endDate = `${m[6]}-${months[m[4]]}-${String(m[5]).padStart(2, "0")}`;
  return { startDate, endDate, dateLabel: String(text || "") };
}

function inferActivityTypeFromCourse(course) {
  const raw = String(course?.AgeSubCatMinMax || "");
  const m = raw.match(/([A-Za-z][A-Za-z\-/ ]+)-\d+\s*-\s*\d+/);
  if (m?.[1]) return m[1].trim();

  const name = String(course?.CourseName || "").trim();
  const beforeColon = name.split(":")[0]?.trim();
  if (beforeColon) return beforeColon;
  return "Other";
}

async function fetchJsonUtfAware(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  const text = decodeLikelyUtf16(buf);
  return JSON.parse(text);
}

async function pooledMap(items, concurrency, task) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await task(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );
  return results;
}

async function main() {
  console.log("Downloading pool locations...");
  const rawLocations = await fetchJsonUtfAware(LOCATION_DATA_URL);
  const features = rawLocations.features ?? [];

  const poolsOnly = features
    .map((f) => f.attributes ?? {})
    .filter((a) => (a.location_type ?? "").toLowerCase().includes("pool"));

  console.log(`Found ${poolsOnly.length} pool locations. Downloading schedules...`);

  const facilities = await pooledMap(poolsOnly, 18, async (attrs, index) => {
    const id = Number(attrs.locationid);
    const scheduleUrl = `${SCHEDULE_BASE_URL}/${id}.json`;

    let rows = [];
    try {
      const schedulePayload = await fetchJsonUtfAware(scheduleUrl);
      const groups = Array.isArray(schedulePayload) ? schedulePayload : [];
      for (const group of groups) {
        if (Array.isArray(group?.r)) rows.push(...group.r);
      }
    } catch {
      rows = [];
    }

    const programs = normalizeScheduleRows(rows, "Swimming");
    const kidPrograms = programs.filter((p) =>
      isYoungKidsProgram({ c: p.activity, age: p.age })
    );

    if (index % 25 === 0) {
      console.log(`Processed ${index + 1}/${poolsOnly.length}`);
    }

    return {
      id,
      name: attrs.complexname ?? "",
      address: attrs.address ?? "",
      locationType: attrs.location_type ?? "",
      activities: attrs.activity_type ?? "",
      amenities: attrs.amenities ?? "",
      website: attrs.website ?? "",
      lat: Number(attrs.y),
      lng: Number(attrs.x),
      programs,
      kidPrograms,
    };
  });

  const withPrograms = facilities.filter((f) => f.programs.length > 0);
  const withKidPrograms = withPrograms.filter((f) => f.kidPrograms.length > 0);

  console.log("Downloading skating rink locations...");
  const rawSkateLocations = await fetchJsonUtfAware(SKATE_LOCATION_DATA_URL);
  const skateFeatures = rawSkateLocations.features ?? [];
  const skateLocations = skateFeatures
    .map((f) => f.attributes ?? {})
    .filter((a) => String(a.show_on_map ?? "").toLowerCase() === "yes");

  console.log(`Found ${skateLocations.length} skating locations. Downloading schedules...`);
  const skateFacilities = await pooledMap(skateLocations, 18, async (attrs, index) => {
    const id = Number(attrs.locationid);
    let rows = [];
    try {
      const schedulePayload = await fetchJsonUtfAware(
        `${SKATE_SCHEDULE_BASE_URL}/${id}.json`
      );
      for (const group of Array.isArray(schedulePayload) ? schedulePayload : []) {
        if (Array.isArray(group?.r)) rows.push(...group.r);
      }
    } catch {
      rows = [];
    }

    const programs = normalizeScheduleRows(rows, "Skating");
    const kidPrograms = programs.filter((p) =>
      isYoungKidsProgram({ c: p.activity, age: p.age })
    );

    if (index % 25 === 0) {
      console.log(`Processed ${index + 1}/${skateLocations.length} skating locations`);
    }

    return {
      id,
      name: attrs.location ?? "",
      address: attrs.address ?? "",
      locationType: `Skating (${attrs.location_type ?? ""})`,
      activities: attrs.activity_type ?? "",
      amenities: attrs.amenities ?? "",
      website: attrs.website ?? "",
      lat: Number(attrs.y),
      lng: Number(attrs.x),
      programs,
      kidPrograms,
    };
  });
  const skateWithPrograms = skateFacilities.filter((f) => f.programs.length > 0);
  const skateWithKidPrograms = skateWithPrograms.filter((f) => f.kidPrograms.length > 0);

  const activityOptions = Array.from(
    new Set(
      withPrograms.flatMap((f) =>
        f.programs.map((p) => (p.activity ?? "").trim()).filter(Boolean)
      )
    )
  ).sort((a, b) => a.localeCompare(b));

  console.log("Downloading registered program locations (dance/sports/fitness/etc.)...");
  const regLocations = await fetchJsonUtfAware(REGAN_LOCATIONS_URL);
  const regRows = Array.isArray(regLocations) ? regLocations : [];

  const regTasks = [];
  for (const row of regRows) {
    const counts = row?.TotalPrograms?.[0] ?? {};
    for (const key of REGAN_CATEGORY_KEYS) {
      const count = Number(counts[key] ?? 0);
      if (Number.isFinite(count) && count > 0) {
        regTasks.push({
          locationId: String(row.LocationID ?? "").trim(),
          locationName: String(row.LocationName ?? "").trim(),
          address: String(row.Address ?? "").trim(),
          district: String(row.District ?? "").trim(),
          website: String(row.WordPressURL ?? "").trim(),
          lat: Number(row.Latitude),
          lng: Number(row.Longitude),
          categoryKey: key,
        });
      }
    }
  }

  console.log(`Fetching ${regTasks.length} registered-program category feeds...`);
  const regProgramsByLocation = new Map();

  await pooledMap(regTasks, 25, async (task, index) => {
    const url = `https://www.toronto.ca/data/parks/prd/regan/${REGAN_SEASON}/${task.locationId}/${task.categoryKey}/all.json`;
    let payload = [];
    try {
      payload = await fetchJsonUtfAware(url);
    } catch {
      payload = [];
    }
    const groups = Array.isArray(payload) ? payload : [];
    const normalized = [];
    for (const g of groups) {
      const activities = Array.isArray(g?.Activities) ? g.Activities : [];
      for (const act of activities) {
        const courses = Array.isArray(act?.Courses) ? act.Courses : [];
        for (const course of courses) {
          const dr = parseReganDateRange(course.StartEnd);
          normalized.push({
            activity: String(course.CourseName ?? "").trim(),
            activityType: inferActivityTypeFromCourse(course),
            category: titleCaseCategory(task.categoryKey),
            age: `${String(course.AgeMin ?? "").trim()} ${String(
              course.AgeMax ?? ""
            ).trim()}`.trim(),
            date: "",
            startDate: dr.startDate,
            endDate: dr.endDate,
            dateLabel: dr.dateLabel,
            time: String(course.Time ?? "").trim(),
            facilityArea: "Registered Program",
            reservable: String(course.InternetReg ?? "").toLowerCase() === "yes",
            source: "registered",
          });
        }
      }
    }

    const key = task.locationId;
    if (!regProgramsByLocation.has(key)) {
      regProgramsByLocation.set(key, {
        id: Number(task.locationId),
        name: task.locationName,
        address: task.address,
        locationType: `Registered Programs (${task.district || "Toronto"})`,
        activities: "",
        amenities: "",
        website: task.website,
        lat: task.lat,
        lng: task.lng,
        programs: [],
        kidPrograms: [],
      });
    }
    const rec = regProgramsByLocation.get(key);
    rec.programs.push(...normalized);

    if ((index + 1) % 100 === 0 || index + 1 === regTasks.length) {
      console.log(`Registered feeds processed ${index + 1}/${regTasks.length}`);
    }
  });

  const regFacilities = Array.from(regProgramsByLocation.values()).filter(
    (f) => f.programs.length > 0 && Number.isFinite(f.lat) && Number.isFinite(f.lng)
  );
  console.log(`Registered facilities with programs: ${regFacilities.length}`);

  const combinedFacilities = [...withPrograms, ...skateWithPrograms, ...regFacilities];
  const combinedActivityOptions = Array.from(
    new Set(
      combinedFacilities.flatMap((f) =>
        f.programs
          .map((p) => (p.activity ?? "").trim())
          .filter(Boolean)
      )
    )
  ).sort((a, b) => a.localeCompare(b));

  const output = {
    generatedAt: new Date().toISOString(),
    source: {
      locations: LOCATION_DATA_URL,
      schedules: `${SCHEDULE_BASE_URL}/{locationid}.json`,
      skateLocations: SKATE_LOCATION_DATA_URL,
      skateSchedules: `${SKATE_SCHEDULE_BASE_URL}/{locationid}.json`,
      reganLocations: REGAN_LOCATIONS_URL,
      reganDetails: `https://www.toronto.ca/data/parks/prd/regan/${REGAN_SEASON}/{locationid}/{category}/all.json`,
    },
    stats: {
      totalPoolLocations: facilities.length,
      swimFacilitiesWithPrograms: withPrograms.length,
      locationsWithKidPrograms: withKidPrograms.length,
      skatingFacilitiesWithPrograms: skateWithPrograms.length,
      skatingLocationsWithKidPrograms: skateWithKidPrograms.length,
      registeredFacilitiesWithPrograms: regFacilities.length,
      totalFacilitiesCombined: combinedFacilities.length,
      // Backward-compatible alias kept for older UI code paths.
      locationsWithPrograms: withPrograms.length,
    },
    activityOptions: combinedActivityOptions,
    facilities: combinedFacilities,
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(OUTPUT_FILE, JSON.stringify(output, null, 2), "utf8");

  console.log(
    `Saved ${combinedFacilities.length} total locations (${withPrograms.length} swim, ${skateWithPrograms.length} skate, ${regFacilities.length} registered) to ${OUTPUT_FILE}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
