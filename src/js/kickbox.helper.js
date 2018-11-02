import axios from 'axios';

// Lodash modules
import cloneDeep from 'lodash/cloneDeep';
import findKey from 'lodash/findKey';
import find from 'lodash/find';
import forEach from 'lodash/forEach';
import debounce from 'lodash/debounce';
import get from 'lodash/get';
import set from 'lodash/set';

import {feature} from '@turf/helpers';

import logger from '@/js/logger';

const lodash = {
  cloneDeep,
  findKey,
  find,
  forEach,
  debounce,
  get,
  set
};

//////////////////////////////
// Public Vars
//////////////////////////////

// #region

let baseLayerParams = {
  format: 'image/png',
  service: 'WMS',
  version: '1.1.1',
  request: 'GetMap',
  srs: 'EPSG:3857'
};

// #endregion Public Vars

//////////////////////////////
// Public Functions
//////////////////////////////

// #region

/**
 * Returns a GeoJSON object representing a bbox that surrounds all of the features
 * for the given table name
 * @param {Object} options - The options used to query the database
 * @param {String} options.kineticaUrl - The URL of Kinetica including the port number
 * @param {String} options.xAttr - Required if using lat/long. The column name of the longitude.
 * @param {String} options.yAttr - Required if using lat/long. The column name of the latitude.
 * @param {String} options.geoAttr - Required if using WKT geometry column. The column name of the WKT.
 * @returns {Object} - The feature object representing the boundary polygon
 */
function getTableBoundary(options) {
  let postOptions = {'table_name': options.tableName, options: {}};
  if (options.geoAttr) {
    postOptions['column_name'] = options.geoAttr;
    // Get the layer bounds
    return axios.post(`${options.kineticaUrl}/aggregate/minmax/geometry`, postOptions)
      .then(wktResults => {
        let minMax = parseDataStr(wktResults.data);

        // Correct for bad data
        if (minMax.max_y > 90) {
          minMax.max_y = 90;
        } else if (minMax.min_y < -90) {
          minMax.min_y = -90;
        }

        return [[minMax.min_x, minMax.min_y], [minMax.max_x, minMax.max_y]];
      });
  }

  postOptions['column_name'] = options.xAttr;
  return axios.post(`${options.kineticaUrl}/aggregate/minmax`, postOptions)
    .then(xResults => {
      let xBounds = parseDataStr(xResults.data);
      postOptions['column_name'] = options.yAttr;
      return axios.post(`${options.kineticaUrl}/aggregate/minmax`, postOptions)
        .then(yResults => {
          let yBounds = parseDataStr(yResults.data);
          // Correct for bad data
          if (yBounds.max > 90) {
            yBounds.max = 90;
          } else if (yBounds.min < -90) {
            yBounds.min = -90;
          }

          if (xBounds.max > 180) {
            xBounds.max = 180;
          } else if (xBounds.min < -180) {
            xBounds.min = -180;
          }

          return [[xBounds.min, yBounds.min], [xBounds.max, yBounds.max]];
        });
    });
}

/**
 * Transforms a Kinetica dynamic schema response's data_string into an array of GeoJSON features.
 * @param {String} dataStr - The data string from the Kinetica query response.
 * @param {*} lonCol - The longitude column name
 * @param {*} latCol - The latitude colum name
 * @returns {Array<Object>} - The array of GeoJSON features.
 */
function dynamicSchemaToGeoJson (dataStr, lonCol, latCol) {
  var data = _parseData(dataStr);
  var features = [];

  // For each feature
  for (var i = 0; i < data.column_1.length; i++) {
    var feature = {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: []
      },
      properties: {}
    };

    // Set the properties
    for (var col = 0; col < data.column_headers.length; col++) {
      var columnHeader = data.column_headers[col];
      var columnData = data[`column_${col + 1}`][i];
      feature.properties[columnHeader] = columnData;
    }

    if (lodash.get(feature, 'properties.atomic_sum', null)) {
      feature.properties.atomic_sum_localized = feature.properties.atomic_sum.toLocaleString();
    }

    // Set the geometry
    feature.geometry.coordinates = [feature.properties[lonCol], feature.properties[latCol]];

    features.push(feature);
  }

  return features;
}

/**
 * Returns a bounds WKT for the passed mapbox getBounds() result.
 * @param {Object} bounds - A Mapbox getBounds() result
 * @returns {String} - A boundary WKT to be used in Kinetica.
 */
function getBoundsWkt (bounds) {
  let boundaryWkt = 'POLYGON((';
  boundaryWkt += `${bounds._sw.lng} ${bounds._ne.lat},`; // A,D 4
  boundaryWkt += `${bounds._ne.lng} ${bounds._ne.lat},`; // C,D 3
  boundaryWkt += `${bounds._ne.lng} ${bounds._sw.lat},`; // C,B 2
  boundaryWkt += `${bounds._sw.lng} ${bounds._sw.lat},`; // A,B 1
  boundaryWkt += `${bounds._sw.lng} ${bounds._ne.lat}`; // A,D 4
  boundaryWkt += '))';
  return `St_GeomFromText('${boundaryWkt}')`;
}

/**
 * Transforms the passed bounds to a polygon feature.
 * @param {object} bounds - The Mapbox bounds array
 * @returns {Object} - A polygon feature object.
 */
function boundsToFeature (bounds) {
  // Get coords and make a valid coordinate array for a polygon
  let coords = getCoordsFromBounds(bounds);
  coords.push(lodash.cloneDeep(coords[0]));

  // Transform it to a feature
  var geometry = {
    'type': 'Polygon',
    'coordinates': coords
  };

  return feature(geometry);
}

/**
 * Returns a coordinate array given a Mapbox lat/long bounds object
 * @param {Object} bounds - The Mapbox lat/long bounds object
 * @returns {Array<Array<Number>>} - The coordinate array
 */
function getCoordsFromBounds (bounds) {
  var coords = [];
  coords.push([bounds._sw.lng, bounds._ne.lat]); // A,D 4
  coords.push([bounds._ne.lng, bounds._ne.lat]); // C,D 3
  coords.push([bounds._ne.lng, bounds._sw.lat]); // C,B 2
  coords.push([bounds._sw.lng, bounds._sw.lat]); // A,B 1
  return coords;
}

/**
 * Returns the current bounding box of the map,
 * formatted to 3857 and ready to be sent to Kinetica.
 * @param {Object} map - The map
 * @returns {String} - A bounding box string for a wms bbox param
 */
function getCurrentBbox (map) {
  var bounds = map.getBounds();
  let projMin = toPseudoMercator(bounds._sw.lng, bounds._sw.lat);
  let projMax = toPseudoMercator(bounds._ne.lng, bounds._ne.lat);
  let bbox = '';
  bbox += projMin.join(',');
  bbox += ',' + projMax.join(',');
  return bbox;
}

/**
 * Takes lon/lat and produces an array of coordinates in EPSG:3857 (pseudo-mercator)
 * @param {Float} lon - Longitude
 * @param {Float} lat - Latitude
 * @returns {Array<Float>} - The converted coordinates
 */
function toPseudoMercator(lon, lat) {
  var x = lon * 20037508.34 / 180;
  var y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180);
  y = y * 20037508.34 / 180;
  return [x, y]
}

/**
 * Gracefully adds a source object to a map
 * @param {Object} map - The Mapbox map object
 * @param {String} sourceId - The source id
 * @param {Object} sourceDef - The source definition
 * @returns {Object} - The source object that was added
 */
function addSource (map, sourceId, sourceDef) {
  let source = map.getSource(sourceId);
  if (source) {
    map.removeSource(sourceId);
  }
  map.addSource(sourceId, sourceDef);
  return map.getSource(sourceId);
}

/**
 * Gracefully adds a layer object to a map
 * @param {Object} map - The Mapbox map object
 * @param {Object} layer - The layer definition
 * @returns {Object} - The layer object that was added
 */
function addLayer (map, layer, before) {
  let existingLayer = map.getLayer(layer.id);
  if (existingLayer) {
    map.removeLayer(layer.id);
  }
  map.addLayer(layer, before);
  return map.getLayer(layer.id);
}

/**
 * Removes a source gracefully from a mapbox map
 * @param {Object} map - The map object
 * @param {Strinb} sourceId - The source id
 */
function removeSource (map, sourceId) {
  let layer = map.getSource(sourceId);
  if (layer) {
    map.removeSource(sourceId);
  }
}

/**
 * Removes a layer gracefully from a map object
 * @param {Object} map - The map object
 * @param {String} layerId - The layer id to remove
 */
function removeLayer (map, layerId) {
  let layer = map.getLayer(layerId);
  if (layer) {
    map.removeLayer(layerId);
  }
}

/**
 * Returns a URL givena base url and a params object
 * @param {String} baseUrl - The base URL
 * @param {*} params - The params object
 * @returns {String} - The final url with params concatenated
 */
function buildUrl (baseUrl, params) {
  return baseUrl + '?' + _joinParams(params);
}

/**
 * Returns the value of the key on the passed object without
 * requiring the case of the key to match the key name. Can
 * pass a default value with which to return in case the key
 * name is not found.
 * @param {Object} obj - The object to search
 * @param {String} keyName - They key name with which to search
 * @param {Any} defaultVal - The default value to return if no key is found
 * @returns {Any} - Either the value at the key name, or the default value
 */
function getNoCase(obj, keyName, defaultVal) {
  let found = find(obj, (val, key) => {
    return key.toLowerCase() === keyName.toLowerCase();
  });
  if (found === undefined) {
    return defaultVal;
  }
  return found;
}

/**
 * Sets a property on an object regardless of case. Warning, this function
 * mutates the passed object.
 * @param {Object} obj - The object to search
 * @param {String} keyName - The name with which to search
 * @param {Any} val - The value to assign
 */
function setNoCase(obj, keyName, val) {
  let found = lodash.findKey(obj, (val, key) => {
    return key.toLowerCase() === keyName.toLowerCase();
  });
  if (!found) {
    obj[keyName] = val;
  }
  obj[found] = val;
}

/**
 * Parses a url and returns only the query params as an object
 * @param {String} url - The url to parse
 * @returns {Object} - The parsed query params
 */
function getQueryParamsObject(url) {
  let queryParams = url.slice(url.indexOf('?') + 1, url.length);
  let layerParams = queryParams.split('&');
  let retVal = {};
  lodash.forEach(layerParams, (param) => {
    if (!param) {
      return;
    }
    let splitted = param.split('=');
    retVal[splitted[0]] = splitted[1];
  });
  return retVal;
}

/**
 * A helper function to easily round a number to a determined number of places.
 * @param {Number} number - The number to round
 * @param {number} places - The number of places after the decimal to round to
 * @returns {Number} - A number rounded to the number of places passed.
 */
function roundTo(number, places) {
  let multiplier = '';
  for (var i = 0; i < places; i++) {
    multiplier += 0;
  }
  multiplier = '1' + multiplier;
  return Math.round(number * multiplier) / multiplier;
}

/**
 * Sets a parameter on the layer params object to either the option
 * if provided, or the default as a fallback. Mutates the layer params object.
 * @param {Object} layerParams - The layer parameters object
 * @param {Object} options - The rendering options
 * @param {Object} defaults - The defaults object
 * @param {String} propName - The name of the property to set
 */
function setOptionOrDefault(layerParams, options, defaults, propName) {
  layerParams[propName] = getNoCase(options, propName, defaults[propName]);
}

function getRecordsJson(data) {
  let results = [];
  try {
    let parsed = parseDataStr(data);
    for (var i = 0; i < parsed.records_json.length; i++) {
      results.push(JSON.parse(parsed.records_json[i]));
    }
  } catch (err) { logger.error(err); return; }
  return results;
}

/**
 * Returns a json schema array from a /get/records type of request
 * @param {Object} data - The returned data object from Axios
 * @returns {Array<Object>} - A json schema array
 */
function getRecordsJsonSchema(data) {
  let results = {};
  let schema = [];
  try {
    let parsed = parseDataStr(data);
    schema = JSON.parse(parsed.type_schema).fields;
  } catch (err) { logger.error(err); return; }

  for (var i = 0; i < schema.length; i++) {
    results[schema[i].name] = schema[i].type;
  }
  return results;
}

function getRecordCount(data) {
  let parsed;
  try {
    parsed = parseDataStr(data);
  } catch (err) {
    logger.error(err);
    return;
  }

  return parsed['total_number_of_records'];
}

/**
 * Parses the coordinate params (x/y/wkt) in the given url
 * @param {String} url - The URL to parse
 * @returns {Object} - An object with the coordinate params inside
 */
function getCoordinateParams(url) {
  let params = getQueryParamsObject(url);
  let retVal = {};

  if (params['X_ATTR'] && params['Y_ATTR']) {
    retVal['X_ATTR'] = params['X_ATTR'];
    retVal['Y_ATTR'] = params['Y_ATTR'];
  } else if (params['GEO_ATTR']) {
    retVal['GEO_ATTR'] = params['GEO_ATTR'];
  }

  return retVal;
}

// #endregion Public Functions

//////////////////////////////
// Private Functions
//////////////////////////////

// #region

/**
 * Returns the next layer after the passed layer ID
 * @param {Object} map - The mapbox map
 * @param {String} layerId - The layer ID
 * @returns {String} - Returns the ID of the layer after
 */
function _getNextLayerId(map, layerId) {
  let layers = map.getStyle().layers
  let index = layers.findIndex(i => i.id === layerId)
  if (index > -1 && index < layers.length - 1) {
    return layers[index + 1].id
  }
  return null
}

/**
 * Adds the source and layer to house the wms images from Kinetica
 * @param {Object} map - The Mapbox map
 * @param {String} wmsUrl - The wms endpoint
 * @param {Object} layerParams - The layer parameters to use to render the wms images
 * @param {Object} options - The options passed from the add function
 */
function bindWmsToSource(map, wmsUrl, layerId, layerParams, options) {
  let mbSourceName = layerId + '-source';
  let mbLayerName = layerId + '-layer';

  // Preserve layer order
  let beforeLayerId = _getNextLayerId(map, mbLayerName)

  let dimensions = getDivDimensions(map._container.id);
  layerParams.bbox = getCurrentBbox(map);
  layerParams.srs = 'EPSG:3857';
  layerParams.height = dimensions.height;
  layerParams.width = dimensions.width;

  let source = map.getSource(mbSourceName)
  let layer = map.getLayer(mbLayerName)

  // Add the source to the map, if not already added
  if (!source) {
    logger.debug('Adding source to the map...')
    addSource(map, mbSourceName, {
      type: 'image',
      url: buildUrl(wmsUrl, layerParams), // Builds the WMS URL from the layer params object
      coordinates: getCoordsFromBounds(map.getBounds()) // Get a coords array from the current Mapbox bounds
    });
  }

  // Add layer to map if not already added
  if (!layer) {
    logger.debug('Adding layer to the map...')
    // Determine where in the layer order to add the layer
    let beforeId;
    let drawLayer = map.getLayer('gl-draw-polygon-fill-inactive.cold');
    if (options && options.before) { // Prefer the passed option
      let beforeLayer = map.getLayer(options.before + '-layer') || map.getLayer(options.before);
      if (beforeLayer) {
        beforeId = beforeLayer.id;
      }
    } else if (beforeLayerId) { // Then the previous position
      beforeId = beforeLayerId;
    } else if (drawLayer) { // Then the MapboxDraw layers
      let beforeLayer = drawLayer;
      if (beforeLayer) {
        beforeId = beforeLayer.id;
      }
    } else { // Then nothing
      beforeId = null;
    }

    // Finally, add the layer
    addLayer(map, {
      id: mbLayerName,
      type: 'raster',
      source: mbSourceName
    }, beforeId);
  }

  // If both source and layer exist, update the image
  if (source && layer && source.updateImage) {
    logger.debug('Updating source image...')
    source.updateImage({
      url: buildUrl(wmsUrl, layerParams), // Builds the WMS URL from the layer params object
      coordinates: getCoordsFromBounds(map.getBounds()) // Get a coords array from the current Mapbox bounds
    })
  }
}

/**
 * Returns div dimensions for the passed id
 * @returns {Object} - A dimensions object with height and width properties.
 */
function getDivDimensions (divId) {
  let div = document.getElementById(divId);
  return {
    height: lodash.get(div, 'clientHeight', 0),
    width: lodash.get(div, 'clientWidth', 0)
  };
}

/**
 * Joins object properties as URL parameters
 * @param {Object} params - The object representing the params
 * @returns {String} - A stringified version of the URL parameters
 */
function _joinParams (params) {
  var retVal = '';
  for (var key in params) {
    retVal += `&${key}=${params[key]}`;
  }
  return retVal;
}

/**
 * Parses the data returned from Kinetica that includes a data_str property
 * @param {Object} data - The data returned from Kinetica
 * @returns {Object} - The results parsed into a Javascript object.
 */
function parseDataStr(data) {
  let results;
  try {
    results = JSON.parse(data.data_str);
  } catch (err) {
    logger.error(err);
    return;
  }
  return results;
}

/**
 * Parses the Kinetica data_str and returns a JSON object.
 * @param {String} dataStr - The data_str from the Kinetica response.
 * @returns {Object} - The unserialized object or an error
 */
function _parseData (dataStr) {
  var data;
  try {
    let jsonData = JSON.parse(dataStr);
    data = JSON.parse(jsonData.json_encoded_response);
  } catch (err) {
    logger.error(err);
  }

  return data;
}

// #endregion Private Functions

//////////////////////////////
// Module Exports
//////////////////////////////

// #region

export default {
  addLayer,
  addSource,
  bindWmsToSource,
  buildUrl,
  baseLayerParams,
  boundsToFeature,
  dynamicSchemaToGeoJson,
  getBoundsWkt,
  getCoordsFromBounds,
  getCoordinateParams,
  getDivDimensions,
  getNoCase,
  getQueryParamsObject,
  getRecordsJson,
  getRecordsJsonSchema,
  getRecordCount,
  getTableBoundary,
  parseDataStr,
  removeLayer,
  removeSource,
  roundTo,
  setNoCase,
  setOptionOrDefault
};

// #endregion Module Exports
