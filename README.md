# Photo Map

Photo Map is an Eagle plugin that pins GPS-tagged images on an interactive map.

## Features

- Loads selected Eagle images when the plugin opens.
- Adds local images by drag and drop, or by clicking the `Selected Images` panel.
- Supports GPS metadata from JPG, JPEG, and PNG files.
- Places image thumbnail pins on the map by latitude and longitude.
- Shows a sortable image list with file name, annotation, tags, and GPS status.
- Reorders images by dragging the row handle.
- Shows selected image details with preview, tags, annotation, latitude, longitude, altitude, and an `Open in Google Maps` button.
- Opens the original image in a larger preview dialog.
- Marks images without GPS metadata with `No GPS data`.
- Marks local files that are not Eagle items with `No Eagle item`.
- Includes a marker-number toggle, route toggle, menu visibility toggle, and map zoom controls.
- Supports keyboard selection with the up and down arrow keys.

## Map

Photo Map uses [Leaflet](https://leafletjs.com/) for the interactive map view.

The basemap uses CARTO's `light_all` tile layer:

```text
https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png
```

Map tiles are loaded online, so an internet connection is required for the map background. Image files, thumbnails, annotations, and tags stay in the plugin window.

When no images are loaded, the map opens around London as the default view.

## Route

The route toggle links GPS-enabled images in the current list order.

Photo Map requests road-following route geometry from the public OSRM demo service:

```text
https://router.project-osrm.org/route/v1/driving/
```

Only longitude and latitude pairs are sent for routing. Image files, thumbnails, file names, annotations, and tags are not sent to OSRM.

If OSRM is unavailable or cannot calculate a route, Photo Map falls back to a dashed straight-line route between the image locations.

Route results are cached for the current image order and coordinates. Selecting a different image does not request the route again. Adding, removing, or reordering images can trigger a new route lookup.

## Supported Images

Photo Map can read GPS metadata from:

- JPG
- JPEG
- PNG with EXIF GPS data

Images without GPS metadata remain in `Selected Images` for review, but they are not pinned on the map.

## Eagle Data

For Eagle items, Photo Map can use:

- File name
- Thumbnail or original image path
- Annotation
- Tags
- External URL, when set
- GPS metadata, when available

For local files added outside Eagle, Eagle-only metadata such as tags and annotations is not available.

## Install

Copy the `eagle-gis-map-plugin` folder into Eagle's plugin directory, or import the packaged ZIP if your Eagle setup supports plugin ZIP installation.

## Development Preview

Run a local static server from the plugin directory:

```bash
python3 -m http.server 5173
```

Then open:

```text
http://127.0.0.1:5173/index.html
```
