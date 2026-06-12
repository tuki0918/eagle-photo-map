let photos = [];
let selectedId = "";
let routeVisible = true;
let leafletMap = null;
let leafletMarkers = [];
let leafletRoute = null;
let leafletRouteFallback = false;
let routeTemporarilyHidden = false;
let routeMotionHideUntil = 0;
let routeRestoreTimer = null;
let routeCache = null;
let routeRequestId = 0;
let routeRenderedKey = "";
let draggedId = "";
let pinView = false;
let markerNumbersVisible = true;
let mapViewInitialized = false;
let pendingMapMove = "fit";
let eagleSelectionLoaded = false;

const defaultMapView = {
  center: [51.5074, -0.1278],
  zoom: 6
};

const els = {
  panelSubtitle: document.querySelector("#panelSubtitle"),
  photoList: document.querySelector("#photoList"),
  markers: document.querySelector("#markers"),
  detailCallout: document.querySelector("#detailCallout"),
  detailPanel: document.querySelector("#detailPanel"),
  routePath: document.querySelector("#routePath"),
  routeLayer: document.querySelector("#routeLayer"),
  markerNumberToggle: document.querySelector("#markerNumberToggle"),
  routeToggle: document.querySelector("#routeToggle"),
  pinViewToggle: document.querySelector("#pinViewToggle"),
  photoPanel: document.querySelector(".photo-panel"),
  fileInput: document.querySelector("#fileInput"),
  resetSelectionButton: document.querySelector("#resetSelectionButton"),
  zoomInButton: document.querySelector("#zoomInButton"),
  zoomOutButton: document.querySelector("#zoomOutButton")
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function stripFileExtension(fileName) {
  const name = String(fileName || "").trim();
  const withoutExtension = name.replace(/\.[^/.]+$/, "");
  return withoutExtension || name;
}

function formatDateTime(value) {
  if (!value) return "";
  if (/^\d{4}:\d{2}:\d{2}/.test(String(value))) {
    value = String(value).replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (num) => String(num).padStart(2, "0");
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDirection(value) {
  const direction = Number(value);
  if (!Number.isFinite(direction)) return "";
  const normalized = ((direction % 360) + 360) % 360;
  return `${Math.round(normalized)}°`;
}

function parseDms(value) {
  if (typeof value === "number") return value;
  if (Array.isArray(value)) {
    const [degrees = 0, minutes = 0, seconds = 0] = value.map(Number);
    const sign = degrees < 0 ? -1 : 1;
    return sign * (Math.abs(degrees) + minutes / 60 + seconds / 3600);
  }
  const text = String(value ?? "").trim();
  if (!text) return null;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return numeric;
  const parts = text.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
  if (!parts?.length) return null;
  const sign = /[SW]/i.test(text) || parts[0] < 0 ? -1 : 1;
  return sign * (Math.abs(parts[0]) + (parts[1] || 0) / 60 + (parts[2] || 0) / 3600);
}

function getTiffValue(view, offset, type, count, littleEndian, tiffStart) {
  const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }[type] || 1;
  const valueOffset = count * typeSize <= 4 ? offset + 8 : tiffStart + view.getUint32(offset + 8, littleEndian);
  const readOne = (entryOffset) => {
    if (type === 2) {
      let text = "";
      for (let i = 0; i < count; i += 1) {
        const code = view.getUint8(valueOffset + i);
        if (code) text += String.fromCharCode(code);
      }
      return text;
    }
    if (type === 3) return view.getUint16(entryOffset, littleEndian);
    if (type === 4) return view.getUint32(entryOffset, littleEndian);
    if (type === 5) {
      const numerator = view.getUint32(entryOffset, littleEndian);
      const denominator = view.getUint32(entryOffset + 4, littleEndian) || 1;
      return numerator / denominator;
    }
    if (type === 9) return view.getInt32(entryOffset, littleEndian);
    if (type === 10) {
      const numerator = view.getInt32(entryOffset, littleEndian);
      const denominator = view.getInt32(entryOffset + 4, littleEndian) || 1;
      return numerator / denominator;
    }
    return view.getUint8(entryOffset);
  };
  if (type === 2) return readOne(valueOffset);
  if (count === 1) return readOne(valueOffset);
  return Array.from({ length: count }, (_, index) => readOne(valueOffset + index * typeSize));
}

function readIfd(view, ifdOffset, littleEndian, tiffStart) {
  const values = {};
  if (!ifdOffset || ifdOffset + 2 >= view.byteLength) return values;
  const entryCount = view.getUint16(ifdOffset, littleEndian);
  for (let index = 0; index < entryCount; index += 1) {
    const entry = ifdOffset + 2 + index * 12;
    if (entry + 12 > view.byteLength) break;
    const tag = view.getUint16(entry, littleEndian);
    const type = view.getUint16(entry + 2, littleEndian);
    const count = view.getUint32(entry + 4, littleEndian);
    values[tag] = getTiffValue(view, entry, type, count, littleEndian, tiffStart);
  }
  return values;
}

function readAscii(view, offset, length) {
  if (offset + length > view.byteLength) return "";
  return Array.from({ length }, (_, index) => String.fromCharCode(view.getUint8(offset + index))).join("");
}

function parseTiffMetadata(view, tiffStart) {
  if (tiffStart + 8 > view.byteLength) return null;
  const endian = view.getUint16(tiffStart);
  const littleEndian = endian === 0x4949;
  if (!littleEndian && endian !== 0x4d4d) return null;
  const firstIfdOffset = tiffStart + view.getUint32(tiffStart + 4, littleEndian);
  const firstIfd = readIfd(view, firstIfdOffset, littleEndian, tiffStart);
  const exifOffset = firstIfd[0x8769];
  const exif = exifOffset ? readIfd(view, tiffStart + exifOffset, littleEndian, tiffStart) : {};
  const gpsOffset = firstIfd[0x8825];
  const gps = gpsOffset ? readIfd(view, tiffStart + gpsOffset, littleEndian, tiffStart) : {};
  const metadata = {
    capturedAt: exif[0x9003] || exif[0x9004] || firstIfd[0x0132] || "",
    direction: parseDms(gps[0x0011]),
    directionRef: gps[0x0010] || ""
  };
  const lat = parseDms(gps[0x0002]);
  const lng = parseDms(gps[0x0004]);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    const latSign = String(gps[0x0001] || "").toUpperCase() === "S" ? -1 : 1;
    const lngSign = String(gps[0x0003] || "").toUpperCase() === "W" ? -1 : 1;
    const altitudeRef = Number(gps[0x0005] || 0);
    const altitude = parseDms(gps[0x0006]);
    metadata.latitude = Math.abs(lat) * latSign;
    metadata.longitude = Math.abs(lng) * lngSign;
    metadata.altitude = Number.isFinite(altitude) ? (altitudeRef === 1 ? -altitude : altitude) : null;
  }
  return metadata;
}

function parsePngExifMetadata(view) {
  if (view.byteLength < 16) return null;
  const signature = [0x89504e47, 0x0d0a1a0a];
  if (view.getUint32(0) !== signature[0] || view.getUint32(4) !== signature[1]) return null;
  let offset = 8;
  while (offset + 12 <= view.byteLength) {
    const length = view.getUint32(offset);
    const type = readAscii(view, offset + 4, 4);
    const dataOffset = offset + 8;
    if (dataOffset + length > view.byteLength) return null;
    if (type === "eXIf") {
      const tiffStart = readAscii(view, dataOffset, 6) === "Exif\u0000\u0000"
        ? dataOffset + 6
        : dataOffset;
      return parseTiffMetadata(view, tiffStart);
    }
    offset = dataOffset + length + 4;
  }
  return null;
}

function parseExifMetadata(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  if (view.byteLength < 4) return null;
  const pngMetadata = parsePngExifMetadata(view);
  if (pngMetadata) return pngMetadata;
  if (view.getUint16(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 4 < view.byteLength) {
    const marker = view.getUint16(offset);
    const length = view.getUint16(offset + 2);
    if (marker === 0xffe1) {
      const signature = readAscii(view, offset + 4, 6);
      if (signature !== "Exif\u0000\u0000") return null;
      return parseTiffMetadata(view, offset + 10);
    }
    offset += 2 + length;
  }
  return null;
}

function sortPhotosForTimeline(items) {
  return [...items].sort((a, b) => {
    const aHasGps = hasRealCoordinates(a);
    const bHasGps = hasRealCoordinates(b);
    if (aHasGps !== bHasGps) return aHasGps ? -1 : 1;
    if (!a.timestamp && !b.timestamp) return 0;
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return a.timestamp.localeCompare(b.timestamp);
  });
}

function groupPhotosByGps(items) {
  return [
    ...items.filter(hasRealCoordinates),
    ...items.filter((photo) => !hasRealCoordinates(photo))
  ];
}

function getFallbackPoint(index) {
  const column = index % 4;
  const row = Math.floor(index / 4) % 4;
  return {
    x: 32 + column * 12,
    y: 28 + row * 14
  };
}

function isSupportedImageFile(file) {
  const supportedExtensions = /\.(jpe?g|png)$/i;
  const supportedTypes = ["image/jpeg", "image/png"];
  return supportedTypes.includes(file.type) || supportedExtensions.test(file.name || "");
}

function getImageExtension(value) {
  return String(value || "")
    .replace(/^\./, "")
    .split(/[?#]/)[0]
    .match(/\.?([a-z0-9]+)$/i)?.[1]
    ?.toLowerCase() || "";
}

function isSupportedImageName(name) {
  return /\.(jpe?g|png)$/i.test(String(name || ""));
}

function pathToFileUrl(value) {
  const text = String(value || "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
  return `file://${encodeURI(text).replaceAll("%5C", "/")}`;
}

function sourceToDisplayUrl(source) {
  if (source instanceof Blob) return URL.createObjectURL(source);
  return pathToFileUrl(source);
}

function isExternalUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function getEagleItemName(item, index) {
  return stripFileExtension(item.name || item.filename || item.fileName || item.title || `Image ${index + 1}`);
}

function getEagleItemPath(item) {
  return item.fileURL || item.fileUrl || item.src || item.path || item.filePath || item.file || item.originalPath || item.absolutePath;
}

function getEagleItemThumb(item) {
  return item.thumbnailURL || item.thumbnailUrl || item.thumbURL || item.thumbUrl || item.thumbnailPath || item.thumbPath || item.previewURL || getEagleItemPath(item);
}

function getEagleItemTags(item) {
  const tags = item.tags || item.tag || [];
  if (Array.isArray(tags)) {
    return tags
      .map((tag) => typeof tag === "string" ? tag : tag?.name)
      .filter(Boolean);
  }
  return [];
}

function getEagleItemAnnotation(item) {
  return item.annotation || item.annotetion || item.note || item.description || "";
}

function getEagleItemExternalUrl(item) {
  const candidates = [
    item.link,
    item.url,
    item.website,
    item.sourceURL,
    item.sourceUrl,
    item.referenceURL,
    item.referenceUrl,
    item.externalURL,
    item.externalUrl
  ];
  return candidates.find(isExternalUrl) || "";
}

function isSupportedEagleItem(item, source) {
  const names = [source, item.name, item.filename, item.fileName, item.filePath, item.ext, item.extension, item.mime, item.type];
  const mime = String(item.mime || item.type || "").toLowerCase();
  const ext = getImageExtension(item.ext || item.extension || item.name || item.filePath || source);
  return names.some((name) => isSupportedImageName(name))
    || ["jpg", "jpeg", "png"].includes(ext)
    || ["image/jpeg", "image/png"].includes(mime);
}

async function fetchArrayBuffer(source) {
  if (source instanceof Blob) return source.arrayBuffer();
  const response = await fetch(pathToFileUrl(source));
  if (!response.ok) {
    throw new Error(`Could not read image data: ${response.status}`);
  }
  return response.arrayBuffer();
}

async function normalizeDroppedFile(file, index) {
  const arrayBuffer = await file.arrayBuffer();
  const imageUrl = URL.createObjectURL(file);
  let exif = null;
  try {
    exif = parseExifMetadata(arrayBuffer);
  } catch (error) {
    console.warn("Dropped image EXIF read failed", error);
  }
  return {
    id: `drop-${Date.now()}-${index}-${file.name}`,
    name: stripFileExtension(file.name) || `Image ${index + 1}`,
    timestamp: formatDateTime(exif?.capturedAt || ""),
    annotation: "",
    tags: [],
    isEagleItem: false,
    latitude: exif?.latitude,
    longitude: exif?.longitude,
    altitude: exif?.altitude,
    direction: exif?.direction,
    directionRef: exif?.directionRef,
    ...getFallbackPoint(index),
    thumb: imageUrl,
    original: imageUrl
  };
}

async function normalizeEagleItem(item, index) {
  const source = getEagleItemPath(item);
  if (!source || !isSupportedEagleItem(item, source)) {
    return null;
  }
  let exif = null;
  try {
    exif = parseExifMetadata(await fetchArrayBuffer(source));
  } catch (error) {
    console.warn("Eagle item EXIF read failed", error);
  }
  return {
    id: `eagle-${item.id || source || index}`,
    name: getEagleItemName(item, index),
    timestamp: formatDateTime(exif?.capturedAt || ""),
    annotation: getEagleItemAnnotation(item),
    tags: getEagleItemTags(item),
    isEagleItem: true,
    latitude: exif?.latitude,
    longitude: exif?.longitude,
    altitude: exif?.altitude,
    direction: exif?.direction,
    directionRef: exif?.directionRef,
    ...getFallbackPoint(index),
    thumb: sourceToDisplayUrl(getEagleItemThumb(item)),
    original: sourceToDisplayUrl(source),
    externalUrl: getEagleItemExternalUrl(item)
  };
}

function normalizeSelectedEagleResult(result) {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if (Array.isArray(result.items)) return result.items;
  if (Array.isArray(result.data)) return result.data;
  if (Array.isArray(result.result)) return result.result;
  if (Array.isArray(result.selected)) return result.selected;
  if (result.item) return [result.item];
  return [];
}

async function resolveEagleItem(item) {
  if (!item || typeof item === "object") {
    return item?.item || item;
  }

  const id = String(item);
  const candidates = [
    () => window.eagle?.item?.getById?.(id),
    () => window.eagle?.item?.get?.(id),
    () => window.eagle?.item?.get?.({ id }),
    () => window.eagle?.item?.get?.({ ids: [id] })
  ];

  for (const candidate of candidates) {
    try {
      const result = await candidate();
      const items = normalizeSelectedEagleResult(result);
      if (items.length) return items[0];
      if (result && typeof result === "object") return result;
    } catch (error) {
      console.warn("Eagle item resolve failed", error);
    }
  }
  return null;
}

async function getSelectedEagleItems() {
  const fields = [
    "id",
    "name",
    "ext",
    "filePath",
    "fileURL",
    "thumbnailURL",
    "tags",
    "annotation",
    "annotetion",
    "url",
    "link",
    "website",
    "sourceURL",
    "referenceURL",
    "externalURL",
    "note",
    "description",
    "createdAt",
    "modifiedAt"
  ];
  const candidates = [
    () => window.eagle?.item?.get?.({ isSelected: true, fields }),
    () => window.eagle?.item?.getSelected?.(),
    () => window.eagle?.item?.getSelectedItems?.(),
    () => window.eagle?.library?.getSelected?.()
  ];
  for (const candidate of candidates) {
    try {
      const result = await candidate();
      const items = normalizeSelectedEagleResult(result);
      if (items.length) {
        return (await Promise.all(items.map(resolveEagleItem))).filter(Boolean);
      }
    } catch (error) {
      console.warn("Eagle selection read failed", error);
    }
  }
  return [];
}

async function waitForEagleApi(timeout = 4000) {
  const startedAt = Date.now();
  while (!window.eagle?.item && Date.now() - startedAt < timeout) {
    await new Promise((resolve) => window.setTimeout(resolve, 80));
  }
  return window.eagle?.item ? window.eagle : null;
}

async function loadSelectedEagleItems({ retries = 4, force = false, preserveMapView = false } = {}) {
  if (eagleSelectionLoaded && !force) return true;
  const eagleApi = await waitForEagleApi();
  if (!eagleApi) {
    document.querySelector("#realMap").dataset.eagleSelection = "api unavailable";
    return false;
  }
  const selectedItems = await getSelectedEagleItems();
  document.querySelector("#realMap").dataset.eagleSelection = `${selectedItems.length} selected`;
  if (!selectedItems.length) {
    if (retries > 0) {
      window.setTimeout(() => loadSelectedEagleItems({ retries: retries - 1, force, preserveMapView }), 350);
    }
    return false;
  }
  const normalizedItems = (await Promise.all(selectedItems.map(normalizeEagleItem))).filter(Boolean);
  document.querySelector("#realMap").dataset.eagleSelectionLoaded = `${normalizedItems.length} images`;
  if (!normalizedItems.length) return false;
  photos.forEach((photo) => {
    if (photo.thumb?.startsWith("blob:")) URL.revokeObjectURL(photo.thumb);
  });
  photos = sortPhotosForTimeline(normalizedItems);
  selectedId = photos[0]?.id || "";
  eagleSelectionLoaded = true;
  markRouteGeometryWillChange();
  if (preserveMapView) {
    mapViewInitialized = true;
    pendingMapMove = "none";
  } else {
    mapViewInitialized = false;
    pendingMapMove = "fit";
  }
  render();
  return true;
}

function clearPhotos({ preserveMapView = false } = {}) {
  photos.forEach((photo) => {
    if (photo.thumb?.startsWith("blob:")) URL.revokeObjectURL(photo.thumb);
    if (photo.original?.startsWith("blob:") && photo.original !== photo.thumb) URL.revokeObjectURL(photo.original);
  });
  photos = [];
  selectedId = "";
  eagleSelectionLoaded = false;
  if (preserveMapView) {
    mapViewInitialized = true;
    pendingMapMove = "none";
  } else {
    mapViewInitialized = false;
    pendingMapMove = "fit";
  }
  clearLeafletLayers();
}

async function resetImagesAndReloadSelection() {
  clearPhotos({ preserveMapView: true });
  await loadSelectedEagleItems({ retries: 0, force: true, preserveMapView: true });
  if (!photos.length) render();
}

function setupEagleSelectionStartupLoad() {
  const loadOnce = () => {
    loadSelectedEagleItems().catch((error) => {
      console.warn("Eagle startup selection load failed", error);
    });
  };

  if (window.eagle?.onPluginCreate) {
    window.eagle.onPluginCreate(loadOnce);
  }
  if (window.eagle?.app?.onPluginCreate) {
    window.eagle.app.onPluginCreate(loadOnce);
  }
  loadOnce();
}

function getDroppedImageFiles(event) {
  return getDroppedFiles(event).filter(isSupportedImageFile);
}

function getDroppedFiles(event) {
  return Array.from(event.dataTransfer?.files || []);
}

function hasFileDrag(event) {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

async function showUnsupportedFileDialog() {
  const message = "Unsupported file extension. Please drop JPG, JPEG, or PNG files.";
  const dialog = window.eagle?.dialog;
  try {
    if (typeof dialog?.showMessageBox === "function") {
      await dialog.showMessageBox({
        type: "warning",
        title: "Unsupported File",
        message
      });
      return;
    }
    if (typeof dialog?.showErrorBox === "function") {
      await dialog.showErrorBox("Unsupported File", message);
      return;
    }
  } catch (error) {
    console.warn("Unsupported file dialog failed", error);
  }
  window.alert(message);
}

function warnIfUnsupportedDroppedFiles(event) {
  const droppedFiles = getDroppedFiles(event);
  const hasUnsupported = droppedFiles.some((file) => !isSupportedImageFile(file));
  if (hasUnsupported) {
    showUnsupportedFileDialog();
  }
}

function clearDropTarget() {
  els.photoPanel.classList.remove("is-drop-target", "is-drop-unsupported");
  clearInsertTargets();
}

function updateDropTarget(event) {
  if (!hasFileDrag(event)) return false;
  const droppedFiles = getDroppedFiles(event);
  const hasKnownFiles = droppedFiles.length > 0;
  const hasSupported = droppedFiles.some(isSupportedImageFile);
  const hasUnsupportedOnly = hasKnownFiles && !hasSupported;
  event.preventDefault();
  event.dataTransfer.dropEffect = hasUnsupportedOnly ? "none" : "copy";
  els.photoPanel.classList.add("is-drop-target");
  els.photoPanel.classList.toggle("is-drop-unsupported", hasUnsupportedOnly);
  return true;
}

function clearInsertTargets() {
  els.photoList.querySelectorAll(".is-insert-before, .is-insert-after, .is-insert-neighbor").forEach((row) => {
    row.classList.remove("is-insert-before", "is-insert-after", "is-insert-neighbor");
  });
  const insertLine = els.photoList.querySelector(".list-insert-line");
  if (insertLine) {
    insertLine.hidden = true;
    insertLine.style.transform = "translateY(0)";
  }
}

function getReorderPlacement(event, row) {
  const rect = row.getBoundingClientRect();
  const y = event.clientY - rect.top;
  const edgeThreshold = Math.min(34, rect.height * 0.34);
  if (y <= edgeThreshold) return "before";
  if (y >= rect.height - edgeThreshold) return "after";
  return row.classList.contains("is-insert-after") ? "after" : "before";
}

function updateInsertTarget(event, row) {
  clearInsertTargets();
  if (!draggedId || draggedId === row.dataset.id) return "before";
  const placement = getReorderPlacement(event, row);
  row.classList.add(placement === "after" ? "is-insert-after" : "is-insert-before");
  if (placement === "before") {
    row.previousElementSibling?.classList.add("is-insert-neighbor");
  } else {
    row.classList.add("is-insert-neighbor");
  }
  const insertLine = els.photoList.querySelector(".list-insert-line");
  if (insertLine) {
    const y = row.offsetTop + (placement === "after" ? row.offsetHeight : 0);
    insertLine.hidden = false;
    insertLine.style.transform = `translateY(${Math.round(y)}px)`;
  }
  return placement;
}

function setFloatingDragImage(event, row) {
  if (!event.dataTransfer || !row) return;
  const dragImage = row.cloneNode(true);
  const rect = row.getBoundingClientRect();
  dragImage.classList.add("drag-image");
  dragImage.style.width = `${rect.width}px`;
  dragImage.style.height = `${rect.height}px`;
  dragImage.style.position = "fixed";
  dragImage.style.left = "-10000px";
  dragImage.style.top = "-10000px";
  document.body.append(dragImage);
  event.dataTransfer.setDragImage(dragImage, 28, Math.min(52, rect.height / 2));
  window.setTimeout(() => dragImage.remove(), 0);
}

async function addDroppedFiles(files) {
  if (!files.length) return;
  const nextPhotos = await Promise.all(files.map((file, index) => normalizeDroppedFile(file, index)));
  photos = sortPhotosForTimeline([...photos, ...nextPhotos]);
  selectedId = nextPhotos[0]?.id || selectedId;
  markRouteGeometryWillChange();
  mapViewInitialized = false;
  pendingMapMove = "fit";
  render();
}

function setupDropZone() {
  ["dragenter", "dragover"].forEach((eventName) => {
    els.photoPanel.addEventListener(eventName, (event) => {
      updateDropTarget(event);
    });
  });

  els.photoPanel.addEventListener("dragleave", (event) => {
    if (!els.photoPanel.contains(event.relatedTarget)) {
      clearDropTarget();
    }
  });

  els.photoPanel.addEventListener("drop", (event) => {
    const files = getDroppedImageFiles(event);
    event.preventDefault();
    clearDropTarget();
    warnIfUnsupportedDroppedFiles(event);
    addDroppedFiles(files);
  });

  window.addEventListener("dragend", clearDropTarget);
  window.addEventListener("dragover", (event) => {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
  });
  window.addEventListener("drop", (event) => {
    if (hasFileDrag(event)) event.preventDefault();
    clearDropTarget();
  });

  els.photoPanel.addEventListener("click", (event) => {
    if (event.target.closest(".photo-row, .remove-item, .drag-handle")) return;
    els.fileInput.click();
  });

  els.fileInput.addEventListener("change", () => {
    const selectedFiles = Array.from(els.fileInput.files || []);
    const files = selectedFiles.filter(isSupportedImageFile);
    if (selectedFiles.some((file) => !isSupportedImageFile(file))) {
      showUnsupportedFileDialog();
    }
    addDroppedFiles(files);
    els.fileInput.value = "";
  });
}

function renderList(items) {
  if (!items.length) {
    els.photoList.innerHTML = `
      <div class="empty-list">
        <span class="empty-upload-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" focusable="false">
            <path d="M12 15V4" />
            <path d="M7.5 8.5 12 4l4.5 4.5" />
            <path d="M5 14.5v3.25A2.25 2.25 0 0 0 7.25 20h9.5A2.25 2.25 0 0 0 19 17.75V14.5" />
          </svg>
        </span>
        <h2>Drop image files here</h2>
        <p>Click to choose GPS photos</p>
        <small>GPS EXIF supported: JPG, JPEG, PNG</small>
      </div>
    `;
    return;
  }

  els.photoList.innerHTML = items.map((photo, index) => {
    const gpsMissing = !hasRealCoordinates(photo);
    return `
      <div class="photo-row ${photo.id === selectedId ? "is-selected" : ""} ${gpsMissing ? "has-no-gps" : ""} ${index === items.length - 1 ? "is-last-row" : ""}" data-id="${escapeHtml(photo.id)}" role="button" tabindex="0" aria-label="${escapeHtml(photo.name)}">
        <span class="drag-handle" draggable="true" data-drag-id="${escapeHtml(photo.id)}" aria-label="Drag to reorder">⋮⋮</span>
        <span class="index-block">${index + 1}</span>
        <img class="thumb" src="${escapeHtml(photo.thumb)}" alt="${escapeHtml(photo.name)}" />
        <span class="row-main">
          <strong class="file-name">${escapeHtml(photo.name)}</strong>
          ${photo.annotation ? `<p class="annotation">${escapeHtml(photo.annotation)}</p>` : ""}
          <span class="tags">${photo.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</span>
          ${renderStatusBadge(photo)}
        </span>
        <button class="remove-item" type="button" data-remove-id="${escapeHtml(photo.id)}" aria-label="Remove ${escapeHtml(photo.name)}">×</button>
      </div>
    `;
  }).join("") + `<span class="list-insert-line" aria-hidden="true" hidden></span>`;

  els.photoList.querySelectorAll(".photo-row").forEach((row) => {
    row.addEventListener("click", (event) => {
      if (event.target.closest(".remove-item")) return;
      if (row.dataset.id === selectedId) {
        selectedId = "";
        pendingMapMove = "none";
        render();
        return;
      }
      selectPhoto(row.dataset.id, { mapMove: "fit" });
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (row.dataset.id === selectedId) {
          selectedId = "";
          pendingMapMove = "none";
          render();
          return;
        }
        selectPhoto(row.dataset.id, { mapMove: "fit" });
      }
    });
    row.addEventListener("dragover", (event) => {
      if (updateDropTarget(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      updateInsertTarget(event, row);
    });
    row.addEventListener("dragleave", () => {
      clearInsertTargets();
    });
    row.addEventListener("drop", (event) => {
      const files = getDroppedImageFiles(event);
      clearDropTarget();
      if (hasFileDrag(event) || files.length) {
        event.preventDefault();
        event.stopPropagation();
        warnIfUnsupportedDroppedFiles(event);
        addDroppedFiles(files);
        return;
      }
      event.preventDefault();
      const placement = getReorderPlacement(event, row);
      reorderPhoto(draggedId || event.dataTransfer.getData("text/plain"), row.dataset.id, placement);
    });
  });

  els.photoList.querySelectorAll(".drag-handle").forEach((handle) => {
    handle.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    handle.addEventListener("dragstart", (event) => {
      draggedId = handle.dataset.dragId;
      const row = handle.closest(".photo-row");
      row?.classList.add("is-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", draggedId);
      setFloatingDragImage(event, row);
    });
    handle.addEventListener("dragend", () => {
      draggedId = "";
      handle.closest(".photo-row")?.classList.remove("is-dragging");
      clearInsertTargets();
    });
  });

  els.photoList.querySelectorAll(".remove-item").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      removePhoto(button.dataset.removeId);
    });
  });

  const selectedRow = els.photoList.querySelector(".photo-row.is-selected");
  selectedRow?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function renderMarkers(items) {
  const selected = photos.find((photo) => photo.id === selectedId);
  els.markers.innerHTML = items.map((photo, index) => {
    return `
      <button class="marker ${photo.id === selectedId ? "is-selected" : ""}" type="button" data-id="${escapeHtml(photo.id)}" style="left:${photo.x}%; top:${photo.y}%">
        <span class="pin-thumb" data-index="${index + 1}">
          <img src="${escapeHtml(photo.thumb)}" alt="${escapeHtml(photo.name)}" />
        </span>
      </button>
    `;
  }).join("");

  els.markers.querySelectorAll(".marker").forEach((marker) => {
    marker.addEventListener("click", () => selectPhoto(marker.dataset.id, { mapMove: "pan" }));
  });

  if (selected) renderCallout(selected);
  if (!selected) renderEmptyDetail();
}

function hasRealCoordinates(photo) {
  return Number.isFinite(photo.latitude) && Number.isFinite(photo.longitude);
}

function renderStatusBadge(photo) {
  if (!hasRealCoordinates(photo)) {
    return `<span class="gps-warning">No GPS data</span>`;
  }
  if (!photo.isEagleItem) {
    return `<span class="source-warning">No Eagle item</span>`;
  }
  return "";
}

function initLeafletMap() {
  if (!window.L) return null;
  if (leafletMap) return leafletMap;
  leafletMap = L.map("realMap", {
    zoomControl: false,
    attributionControl: true
  });
  leafletMap.attributionControl.setPrefix('<a href="https://leafletjs.com/" target="_blank" rel="noopener noreferrer">Leaflet</a>');
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    crossOrigin: true,
    attribution: 'Map data &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> &middot; Tiles &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener noreferrer">CARTO</a>'
  }).addTo(leafletMap);
  leafletMap.on("zoomstart", hideLeafletRouteForMapMotion);
  leafletMap.on("moveend zoomend", () => {
    updateMapDebugState();
    restoreLeafletRouteAfterMapMotion();
  });
  return leafletMap;
}

function showDefaultMapView() {
  const map = initLeafletMap();
  if (!map) return false;
  document.querySelector(".map-surface").classList.add("has-real-map");
  map.setView(defaultMapView.center, defaultMapView.zoom, { animate: false });
  window.setTimeout(() => {
    map.invalidateSize();
    updateMapDebugState();
  }, 0);
  return true;
}

function clearLeafletMarkers() {
  leafletMarkers.forEach((marker) => marker.remove());
  leafletMarkers = [];
}

function clearLeafletRoute() {
  if (leafletRoute) {
    leafletRoute.remove();
    leafletRoute = null;
  }
  leafletRouteFallback = false;
  routeRenderedKey = "";
  routeRequestId += 1;
}

function clearLeafletLayers() {
  clearLeafletMarkers();
  clearLeafletRoute();
}

function updateMapDebugState() {
  if (!leafletMap) return;
  const mapElement = document.querySelector("#realMap");
  mapElement.dataset.zoom = String(leafletMap.getZoom());
  const center = leafletMap.getCenter();
  mapElement.dataset.center = `${center.lat.toFixed(6)},${center.lng.toFixed(6)}`;
}

function straightRouteLatLngs(items) {
  return items.map((photo) => [photo.latitude, photo.longitude]);
}

function getLeafletRouteOpacity(isFallback) {
  return isFallback ? 0.42 : 0.78;
}

function markRouteGeometryWillChange() {
  routeMotionHideUntil = Date.now() + 1400;
}

function hideLeafletRouteForMapMotion() {
  if (Date.now() > routeMotionHideUntil) return;
  routeTemporarilyHidden = true;
  if (routeRestoreTimer) {
    window.clearTimeout(routeRestoreTimer);
    routeRestoreTimer = null;
  }
  leafletRoute?.setStyle({ opacity: 0 });
}

function restoreLeafletRouteAfterMapMotion() {
  if (routeRestoreTimer) window.clearTimeout(routeRestoreTimer);
  routeRestoreTimer = window.setTimeout(() => {
    routeMotionHideUntil = 0;
    routeTemporarilyHidden = false;
    if (routeVisible && leafletRoute) {
      leafletRoute.setStyle({ opacity: getLeafletRouteOpacity(leafletRouteFallback) });
    }
  }, 160);
}

function getRouteKey(items) {
  return items
    .map((photo) => `${photo.id}:${photo.latitude.toFixed(6)},${photo.longitude.toFixed(6)}`)
    .join("|");
}

async function fetchRoadRoute(items) {
  const coordinates = items
    .map((photo) => `${photo.longitude},${photo.latitude}`)
    .join(";");
  const url = `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson&steps=false`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Route request failed: ${response.status}`);
  }
  const data = await response.json();
  const routeCoordinates = data?.routes?.[0]?.geometry?.coordinates;
  if (!Array.isArray(routeCoordinates) || routeCoordinates.length < 2) {
    throw new Error("Route response did not contain geometry");
  }
  return routeCoordinates.map(([longitude, latitude]) => [latitude, longitude]);
}

function drawLeafletRoute(map, latLngs, options = {}) {
  const nextFallback = Boolean(options.fallback);
  const nextKey = options.key || "";
  if (leafletRoute && routeRenderedKey === nextKey && leafletRouteFallback === nextFallback) {
    leafletRoute.setStyle({
      opacity: routeVisible && !routeTemporarilyHidden ? getLeafletRouteOpacity(nextFallback) : 0
    });
    return;
  }
  if (leafletRoute) {
    leafletRoute.remove();
    leafletRoute = null;
  }
  leafletRouteFallback = nextFallback;
  routeRenderedKey = nextKey;
  leafletRoute = L.polyline(latLngs, {
    color: "#2f7df6",
    weight: nextFallback ? 3 : 4,
    opacity: routeVisible && !routeTemporarilyHidden ? getLeafletRouteOpacity(nextFallback) : 0,
    dashArray: nextFallback ? "8 8" : null,
    lineCap: "round",
    lineJoin: "round"
  }).addTo(map);
  document.querySelector("#realMap").dataset.routeMode = nextFallback ? "straight fallback" : "road route";
}

async function renderLeafletRoute(map, coordinateItems) {
  if (coordinateItems.length < 2) {
    clearLeafletRoute();
    document.querySelector("#realMap").dataset.routeMode = "none";
    return;
  }
  const routeKey = getRouteKey(coordinateItems);
  if (!routeVisible) {
    leafletRoute?.setStyle({ opacity: 0 });
    document.querySelector("#realMap").dataset.routeMode = "hidden";
    return;
  }
  if (leafletRoute && routeRenderedKey === routeKey) {
    leafletRoute.setStyle({ opacity: routeTemporarilyHidden ? 0 : getLeafletRouteOpacity(leafletRouteFallback) });
    document.querySelector("#realMap").dataset.routeCache = "kept";
    return;
  }
  if (routeCache?.key === routeKey) {
    drawLeafletRoute(map, routeCache.latLngs, { fallback: routeCache.fallback, key: routeKey });
    document.querySelector("#realMap").dataset.routeCache = "hit";
    return;
  }

  routeRequestId += 1;
  const requestId = routeRequestId;
  const fallbackLatLngs = straightRouteLatLngs(coordinateItems);
  drawLeafletRoute(map, fallbackLatLngs, { fallback: true, key: routeKey });
  document.querySelector("#realMap").dataset.routeCache = "miss";
  try {
    const routedLatLngs = await fetchRoadRoute(coordinateItems);
    if (requestId !== routeRequestId || !routeVisible) return;
    routeCache = {
      key: routeKey,
      latLngs: routedLatLngs,
      fallback: false
    };
    drawLeafletRoute(map, routedLatLngs, { fallback: false, key: routeKey });
  } catch (error) {
    if (requestId === routeRequestId) {
      routeCache = {
        key: routeKey,
        latLngs: fallbackLatLngs,
        fallback: true
      };
    }
    console.warn("Road route unavailable; using straight fallback", error);
  }
}

function renderLeafletMap(items) {
  const coordinateItems = items.filter(hasRealCoordinates);
  const map = initLeafletMap();
  const mapSurface = document.querySelector(".map-surface");
  const mapElement = document.querySelector("#realMap");
  mapElement.dataset.coordinateItems = String(coordinateItems.length);
  mapSurface.classList.remove("has-real-map");
  clearLeafletMarkers();
  if (!map) {
    mapElement.dataset.leafletMarkers = "0";
    clearLeafletRoute();
    return false;
  }
  mapSurface.classList.add("has-real-map");
  if (!coordinateItems.length) {
    mapElement.dataset.leafletMarkers = "0";
    mapElement.dataset.routeMode = "none";
    clearLeafletRoute();
    window.setTimeout(() => {
      map.invalidateSize();
      if (!mapViewInitialized || pendingMapMove === "fit") {
        map.setView(defaultMapView.center, defaultMapView.zoom, { animate: false });
      }
      mapViewInitialized = true;
      pendingMapMove = "none";
      updateMapDebugState();
    }, 80);
    return true;
  }

  const bounds = coordinateItems.map((photo) => [photo.latitude, photo.longitude]);
  if (!mapViewInitialized) {
    if (bounds.length === 1) {
      map.setView(bounds[0], 15, { animate: false });
    } else {
      const fitOptions = pinView
        ? { padding: [120, 120], maxZoom: 16, animate: false }
        : { paddingTopLeft: [430, 120], paddingBottomRight: [430, 160], maxZoom: 16, animate: false };
      map.fitBounds(bounds, fitOptions);
    }
  }

  try {
    coordinateItems.forEach((photo, index) => {
      const selected = photo.id === selectedId;
      const icon = L.divIcon({
        className: "",
        html: `<div class="leaflet-photo-marker ${selected ? "is-selected" : ""}" data-index="${index + 1}"><img src="${escapeHtml(photo.thumb)}" alt="${escapeHtml(photo.name)}"></div>`,
        iconSize: selected ? [128, 146] : [64, 76],
        iconAnchor: selected ? [64, 144] : [32, 74]
      });
      const marker = L.marker([photo.latitude, photo.longitude], { icon }).addTo(map);
      marker.on("click", () => selectPhoto(photo.id, { mapMove: "pan" }));
      leafletMarkers.push(marker);

    });
  } catch (error) {
    console.warn("Leaflet marker render failed", error);
    clearLeafletMarkers();
    return false;
  }

  if (!leafletMarkers.length) {
    mapElement.dataset.leafletMarkers = "0";
    clearLeafletMarkers();
    clearLeafletRoute();
    return false;
  }

  mapElement.dataset.leafletMarkers = String(leafletMarkers.length);
  renderLeafletRoute(map, coordinateItems);

  const moveType = mapViewInitialized ? pendingMapMove : "fit";
  window.setTimeout(() => {
    map.invalidateSize();
    const selected = coordinateItems.find((photo) => photo.id === selectedId);
    if (moveType === "pan" && selected) {
      map.panTo([selected.latitude, selected.longitude], {
        animate: true,
        duration: 0.55,
        easeLinearity: 0.22
      });
    } else if (moveType === "fit") {
      if (bounds.length === 1) {
        map.flyTo(bounds[0], Math.max(map.getZoom() || 0, 15), {
          animate: true,
          duration: 0.65,
          easeLinearity: 0.22
        });
      } else {
        const fitOptions = pinView
          ? { padding: [120, 120], maxZoom: 16, animate: true, duration: 0.65 }
          : { paddingTopLeft: [430, 120], paddingBottomRight: [430, 160], maxZoom: 16, animate: true, duration: 0.65 };
        map.flyToBounds(bounds, fitOptions);
      }
    }
    mapViewInitialized = true;
    pendingMapMove = "none";
    updateMapDebugState();
  }, 80);
  return true;
}

function renderRoute() {
  const points = photos.map((photo) => `${(photo.x / 100) * 1440} ${(photo.y / 100) * 1024}`);
  els.routePath.setAttribute("d", points.length ? `M ${points.join(" L ")}` : "");
  els.routeLayer.classList.toggle("is-hidden", !routeVisible);
  els.routeToggle.classList.toggle("is-on", routeVisible);
  els.routeToggle.setAttribute("aria-pressed", String(routeVisible));
  els.routeToggle.title = routeVisible ? "Hide route" : "Show route";
}

function renderCallout(photo) {
  const latitudeText = Number.isFinite(photo.latitude) ? photo.latitude.toFixed(6) : "Unknown";
  const longitudeText = Number.isFinite(photo.longitude) ? photo.longitude.toFixed(6) : "Unknown";
  const altitudeText = Number.isFinite(photo.altitude) ? `${photo.altitude.toFixed(2)} m` : "Unknown";
  const directionText = formatDirection(photo.direction);
  const timeBadge = photo.timestamp
    ? `<span class="detail-time-badge">${escapeHtml(photo.timestamp)}</span>`
    : "";
  const directionBadge = directionText
    ? `<span class="detail-direction-badge" data-tooltip="${escapeHtml(directionText)}" aria-label="Photo direction ${escapeHtml(directionText)}">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" style="transform: rotate(${Number(photo.direction)}deg)">
          <path d="M12 3 4.5 21 12 16.8 19.5 21 12 3Z" />
        </svg>
      </span>`
    : "";
  const previewControls = `
    <div class="detail-preview-actions">
      ${timeBadge}
      ${directionBadge}
      <button class="preview-button preview-image-button" type="button" aria-label="Preview image" title="Preview image">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
          <circle cx="12" cy="12" r="2.75" />
        </svg>
      </button>
    </div>
  `;
  const googleUrl = Number.isFinite(photo.latitude) && Number.isFinite(photo.longitude)
    ? `https://www.google.com/maps/search/?api=1&query=${photo.latitude},${photo.longitude}`
    : "https://www.google.com/maps";

  els.detailPanel.innerHTML = `
    <div class="detail-media">
      <span class="detail-media-backdrop" aria-hidden="true">
        <img src="${escapeHtml(photo.thumb)}" alt="" />
      </span>
      <img class="detail-image" src="${escapeHtml(photo.thumb)}" alt="${escapeHtml(photo.name)}" />
      ${photo.externalUrl ? `
        <button class="preview-button external-link-button" type="button" data-url="${escapeHtml(photo.externalUrl)}" aria-label="Open external URL" title="Open external URL">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M15 3h6v6" />
            <path d="M10 14 21 3" />
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          </svg>
        </button>
      ` : ""}
      ${previewControls}
    </div>
    <div class="detail-body">
      <h2 class="detail-title">${escapeHtml(photo.name)}</h2>
      ${photo.annotation ? `<p class="detail-note">${escapeHtml(photo.annotation)}</p>` : ""}
      <div class="tags detail-tags ${photo.tags.length ? "has-tags" : ""}">
        ${photo.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}
        ${renderStatusBadge(photo)}
      </div>
      <div class="detail-meta">
        <span><strong>Latitude</strong><em>${escapeHtml(latitudeText)}</em></span>
        <span><strong>Longitude</strong><em>${escapeHtml(longitudeText)}</em></span>
        <span><strong>Altitude</strong><em>${escapeHtml(altitudeText)}</em></span>
      </div>
      <button class="google-link" type="button" data-url="${escapeHtml(googleUrl)}">Open in Google Maps</button>
    </div>
  `;

  els.detailPanel.querySelector(".google-link").addEventListener("click", (event) => {
    const url = event.currentTarget.dataset.url;
    if (window.eagle?.shell?.openExternal) {
      window.eagle.shell.openExternal(url);
    } else {
      window.open(url, "_blank", "noopener");
    }
  });
  els.detailPanel.querySelector(".preview-image-button").addEventListener("click", () => {
    openImagePreview(photo);
  });
  els.detailPanel.querySelector(".external-link-button")?.addEventListener("click", (event) => {
    openExternalUrl(event.currentTarget.dataset.url);
  });
  updateDetailImageLayout();
  els.detailPanel.hidden = false;
}

function updateDetailImageLayout() {
  const media = els.detailPanel.querySelector(".detail-media");
  const image = els.detailPanel.querySelector(".detail-image");
  if (!media || !image) return;
  const apply = () => {
    const { naturalWidth, naturalHeight } = image;
    if (!naturalWidth || !naturalHeight) return;
    const ratio = naturalWidth / naturalHeight;
    media.classList.toggle("is-portrait", ratio < 0.9);
    media.classList.toggle("is-square", ratio >= 0.9 && ratio <= 1.1);
    media.classList.toggle("is-landscape", ratio > 1.1);
  };
  if (image.complete) {
    apply();
  } else {
    image.addEventListener("load", apply, { once: true });
  }
}

function openExternalUrl(url) {
  if (!url) return;
  if (window.eagle?.shell?.openExternal) {
    window.eagle.shell.openExternal(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

function closeImagePreview() {
  document.querySelector(".image-preview-dialog")?.remove();
}

function openImagePreview(photo) {
  closeImagePreview();
  const imageSrc = photo.original || photo.thumb;
  const dialog = document.createElement("div");
  dialog.className = "image-preview-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", `${photo.name} preview`);
  dialog.innerHTML = `
    <button class="preview-backdrop" type="button" aria-label="Close preview"></button>
    <div class="preview-content">
      <button class="preview-close" type="button" aria-label="Close preview">×</button>
      <img src="${escapeHtml(imageSrc)}" alt="${escapeHtml(photo.name)}" />
      <p>${escapeHtml(photo.name)}</p>
    </div>
  `;
  dialog.querySelector(".preview-backdrop").addEventListener("click", closeImagePreview);
  dialog.querySelector(".preview-close").addEventListener("click", closeImagePreview);
  document.body.append(dialog);
  dialog.querySelector(".preview-close").focus();
}

function renderEmptyDetail() {
  els.detailPanel.innerHTML = "";
  els.detailPanel.hidden = true;
}

function renderStatus() {
  if (photos.length) {
    const itemLabel = photos.length === 1 ? "item" : "items";
    els.panelSubtitle.textContent = `Timeline - ${photos.length} ${itemLabel}`;
  } else {
    els.panelSubtitle.textContent = "Drop image files here";
  }
}

function getMarkerNumberToggleIcon() {
  if (markerNumbersVisible) {
    return `
      <svg class="lucide-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M19.914 11.105A7.298 7.298 0 0 0 20 10a8 8 0 0 0-16 0c0 4.993 5.539 10.193 7.399 11.799a1 1 0 0 0 1.202 0 32 32 0 0 0 .824-.738" />
        <circle cx="12" cy="10" r="3" />
        <path d="M16 18h6" />
        <path d="M19 15v6" />
      </svg>
    `;
  }
  return `
    <svg class="lucide-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  `;
}

function render() {
  const items = photos;
  const mapSurface = document.querySelector(".map-surface");
  mapSurface.classList.toggle("pin-view", pinView);
  mapSurface.classList.toggle("hide-marker-numbers", !markerNumbersVisible);
  els.markerNumberToggle.classList.toggle("is-on", markerNumbersVisible);
  els.markerNumberToggle.setAttribute("aria-pressed", String(markerNumbersVisible));
  els.markerNumberToggle.title = markerNumbersVisible ? "Hide map numbers" : "Show map numbers";
  els.markerNumberToggle.setAttribute("aria-label", markerNumbersVisible ? "Hide map numbers" : "Show map numbers");
  els.markerNumberToggle.innerHTML = getMarkerNumberToggleIcon();
  els.pinViewToggle.classList.toggle("is-on", pinView);
  els.pinViewToggle.setAttribute("aria-pressed", String(pinView));
  els.pinViewToggle.title = pinView ? "Show menu" : "Hide menu";
  els.pinViewToggle.setAttribute("aria-label", pinView ? "Show menu" : "Hide menu");
  renderStatus();
  renderList(items);
  const renderedRealMap = renderLeafletMap(items);
  if (!renderedRealMap) {
    renderMarkers(items);
  } else {
    els.markers.innerHTML = "";
    const selected = photos.find((photo) => photo.id === selectedId);
    if (selected) renderCallout(selected);
  }
  renderRoute();
  if (!photos.find((photo) => photo.id === selectedId)) {
    renderEmptyDetail();
  }
  if (!items.length) {
    els.detailCallout.hidden = true;
    renderEmptyDetail();
  }
}

function selectPhoto(id, options = {}) {
  selectedId = id;
  pendingMapMove = options.mapMove || "none";
  render();
}

function selectAdjacentPhoto(direction) {
  if (!photos.length) return;
  const currentIndex = photos.findIndex((photo) => photo.id === selectedId);
  let nextIndex = currentIndex + direction;
  if (currentIndex < 0) {
    nextIndex = direction > 0 ? 0 : photos.length - 1;
  }
  nextIndex = Math.max(0, Math.min(photos.length - 1, nextIndex));
  if (photos[nextIndex]?.id && photos[nextIndex].id !== selectedId) {
    selectPhoto(photos[nextIndex].id, { mapMove: "fit" });
  }
}

function removePhoto(id) {
  const index = photos.findIndex((photo) => photo.id === id);
  if (index < 0) return;
  if (photos[index].thumb?.startsWith("blob:")) {
    URL.revokeObjectURL(photos[index].thumb);
  }
  photos = photos.filter((photo) => photo.id !== id);
  markRouteGeometryWillChange();
  if (selectedId === id) {
    selectedId = photos[index]?.id || photos[index - 1]?.id || photos[0]?.id || "";
    pendingMapMove = "pan";
  }
  render();
}

function reorderPhoto(sourceId, targetId, placement = "before") {
  if (!sourceId || !targetId || sourceId === targetId) return;
  const sourceIndex = photos.findIndex((photo) => photo.id === sourceId);
  const targetIndex = photos.findIndex((photo) => photo.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return;
  const next = [...photos];
  const [moved] = next.splice(sourceIndex, 1);
  const insertIndex = next.findIndex((photo) => photo.id === targetId);
  next.splice(placement === "after" ? insertIndex + 1 : insertIndex, 0, moved);
  photos = groupPhotosByGps(next);
  selectedId = sourceId;
  markRouteGeometryWillChange();
  pendingMapMove = "none";
  render();
}

async function init() {
  showDefaultMapView();
  photos = [];
  selectedId = "";
  pendingMapMove = "fit";
  setupDropZone();
  render();
  setupEagleSelectionStartupLoad();
}

function zoomMap(delta) {
  pendingMapMove = "none";
  if (leafletMap && document.querySelector(".map-surface").classList.contains("has-real-map")) {
    const nextZoom = leafletMap.getZoom() + delta;
    leafletMap.setZoom(nextZoom, { animate: true });
    window.setTimeout(updateMapDebugState, 350);
    return;
  }
  const mapSurface = document.querySelector(".map-surface");
  mapSurface.animate(
    [
      { transform: "scale(1)" },
      { transform: `scale(${delta > 0 ? 1.015 : 0.985})` },
      { transform: "scale(1)" }
    ],
    { duration: 220, easing: "ease-out" }
  );
}

els.routeToggle.addEventListener("click", () => {
  routeVisible = !routeVisible;
  pendingMapMove = "none";
  render();
});

els.markerNumberToggle.addEventListener("click", () => {
  markerNumbersVisible = !markerNumbersVisible;
  pendingMapMove = "none";
  render();
});

els.pinViewToggle.addEventListener("click", () => {
  pinView = !pinView;
  pendingMapMove = "none";
  render();
});

els.resetSelectionButton.addEventListener("click", (event) => {
  event.stopPropagation();
  resetImagesAndReloadSelection().catch((error) => {
    console.warn("Selection reset failed", error);
  });
});

els.zoomInButton.addEventListener("click", () => zoomMap(1));
els.zoomOutButton.addEventListener("click", () => zoomMap(-1));

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeImagePreview();
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    if (event.target.closest?.("input, textarea, select, [contenteditable='true']")) return;
    event.preventDefault();
    selectAdjacentPhoto(event.key === "ArrowDown" ? 1 : -1);
  }
});

init().catch((error) => {
  console.error(error);
  photos = [];
  selectedId = "";
  render();
});
