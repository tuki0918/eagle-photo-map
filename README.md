# Eagle | Photo Map

Photo Map is an Eagle window plugin for viewing GPS-tagged photos on a map.

## Features

- Show selected Eagle images as photo pins on an interactive map.
- Read GPS metadata from JPG, JPEG, and PNG files.
- Add local images by drag and drop.
- View photo details, tags, annotations, coordinates, and altitude.
- Reorder photos and draw a route in the current order.
- Open a selected location in Google Maps.

## Requirements

- Eagle 4.0 Build 23 or later
- Photos with GPS metadata.
- An internet connection for map tiles and route lookup.

## Usage

1. Select GPS-tagged images in Eagle.
2. Open Photo Map.
3. Click a photo pin or list item to view details.
4. Drag items to change the order.
5. Turn on the route option to connect the photos.

## Limitations

- Photos without GPS metadata are shown in the list, but not on the map.
- Local files added outside Eagle do not include Eagle-only metadata such as tags or annotations.
- Map tiles and route lookup are loaded online.
- Map attribution is displayed for Leaflet, OpenStreetMap, and CARTO.
