/******************************************************************************

Flatmap viewer and annotation tool

Copyright (c) 2019  David Brooks

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

******************************************************************************/

'use strict';

//==============================================================================

import maplibre from 'maplibre-gl';

import {default as turfArea} from '@turf/area';
import {default as turfBBox} from '@turf/bbox';
import * as turf from '@turf/helpers';
import * as turfProjection from '@turf/projection';

import polylabel from 'polylabel';

//==============================================================================

import {ContextMenu} from './contextmenu.js';
import {displayedProperties} from './info.js';
import {InfoControl} from './info.js';
import {LayerManager} from './layers.js';
import {PATHWAYS_LAYER, Pathways} from './pathways.js';
import {BackgroundControl, LayerControl, PathControl, SCKANControl} from './controls.js';
import {SearchControl} from './search.js';
import {VECTOR_TILES_SOURCE} from './styling.js';

import * as pathways from './pathways.js';
import * as utils from './utils.js';

//==============================================================================


// smallest `group` features when zoom < SHOW_DETAILS_ZOOM if there are some, otherwise smallest feature
// if no non-group features then smallest group one

const SHOW_DETAILS_ZOOM = 6;

//==============================================================================

function bounds(feature)
//======================
{
    // Find the feature's bounding box

    let bounds = ('bounds' in feature.properties) ? feature.properties.bounds
                                                  : feature.properties.bbox;
    if (bounds) {
        // Bounding box is defined in GeoJSON

        return JSON.parse(bounds);
    } else {
        // Get the bounding box of the current polygon. This won't neccessary
        // be the full feature because of tiling

        const polygon = turf.geometry(feature.geometry.type, feature.geometry.coordinates);
        return turfBBox(polygon);
    }
}

//==============================================================================

function expandBounds(bbox1, bbox2)
//=================================
{
    return (bbox1 === null) ? bbox2
                            : [Math.min(bbox1[0], bbox2[0]), Math.min(bbox1[1], bbox2[1]),
                               Math.max(bbox1[2], bbox2[2]), Math.max(bbox1[3], bbox2[3])
                              ];
}

//==============================================================================

export class UserInteractions
{
    constructor(flatmap)
    {
        this._flatmap = flatmap;
        this._map = flatmap.map;

        this._activeFeatures = [];
        this._selectedFeatureIds = new Map();
        this._currentPopup = null;
        this._infoControl = null;
        this._tooltip = null;

        this._disabledPathFeatures = false;

        this._inQuery = false;
        this._modal = false;

        // Default colour settings

        this.__colourOptions = {colour: true, outline: true};

        // Marker placement and interaction

        this.__activeMarker = null;
        this.__lastMarkerId = 900000;
        this.__markerIdByMarker = new Map();
        this.__annotationByMarkerId = new Map();

        // Where to put labels and popups on a feature
        this.__centralPositions = new Map();

        // Fit the map to its initial position

        flatmap.setInitialPosition();

        // Add and manage our layers

        this._layerManager = new LayerManager(flatmap);

        // Path visibility is either controlled externally or by a local control

        this._pathways = new Pathways(flatmap);

        // The path types in this map
        const mapPathTypes = this._pathways.pathTypes();

        // Disable paths that are not initially shown
        for (const path of mapPathTypes) {
            if ('enabled' in path && !path.enabled) {
                this.enablePath(path.type, false);
            }
        }

        // Add various controls when running standalone

        if (flatmap.options.standalone) {
            // Add a control to search annotations if option set
            this._map.addControl(new SearchControl(flatmap));

            // Show information about features
            this._infoControl = new InfoControl(flatmap);
            this._map.addControl(this._infoControl);

            // Control background colour (NB. this depends on having map layers created)
            this._map.addControl(new BackgroundControl(flatmap));

            // Add a control to manage our paths
            this._map.addControl(new PathControl(flatmap, mapPathTypes));

            // Add a control to manage our layers
            this._map.addControl(new LayerControl(flatmap, this._layerManager));

            // A SCKAN path control for FC maps
            if (flatmap.options.style === 'fcdiagram') {
                this._map.addControl(new SCKANControl(flatmap));
            }
        }

        // Flag features that have annotations
        // Also flag those features that are models of something

        for (const [id, ann] of flatmap.annotations) {
            const feature = this.mapFeature_(id);
            if (feature !== undefined) {
                this._map.setFeatureState(feature, { 'annotated': true });
            }
        }

        // Display a context menu on right-click

        this._lastContextTime = 0;
        this._contextMenu = new ContextMenu(flatmap, this.__clearModal.bind(this));
        this._map.on('contextmenu', this.contextMenuEvent_.bind(this));

        // Display a context menu with a touch longer than 0.5 second

        this._lastTouchTime = 0;
        this._map.on('touchstart', (e) => { this._lastTouchTime = Date.now(); });
        this._map.on('touchend', (e) => {
            if (Date.now() > (this._lastTouchTime + 500)) {
                this.contextMenuEvent_(e);
            }
        });

        // Handle mouse events

        this._map.on('click', this.clickEvent_.bind(this));
        this._map.on('mousemove', this.mouseMoveEvent_.bind(this));
        this._lastFeatureMouseEntered = null;
        this._lastFeatureModelsMouse = null;
        this.__lastClickLngLat = null;

        // Handle pan/zoom events
        this._map.on('move', this.panZoomEvent_.bind(this, 'pan'));
        this._map.on('zoom', this.panZoomEvent_.bind(this, 'zoom'));
        this.__pan_zoom_enabled = false;
    }

    get pathways()
    //============
    {
        return this._pathways;
    }

    getState()
    //========
    {
        // Return the map's centre, zoom, and active layers
        // Can only be called when the map is fully loaded
        return {
            center: this._map.getCenter().toArray(),
            zoom: this._map.getZoom(),
            layers: this.layers
        };
    }

    setState(state)
    //=============
    {
        // Restore the map to a saved state
        const options = {};
        if ('center' in state) {
            options['center'] = state.center;
        }
        if ('zoom' in state) {
            options['zoom'] = state.zoom;
            if ('center' in state) {
                options['around'] = state.center;
            } else {
                options['around'] = [0, 0];
            }
        }
        if (Object.keys(options).length > 0) {
            this._map.jumpTo(options);
        }
    }

    setColour(options)
    //================
    {
        this.__colourOptions = options;
        this._layerManager.setColour(options);
    }

    getLayers()
    //=========
    {
        return this._layerManager.layers;
    }

    enableLayer(layerId, enable=true)
    //===============================
    {
        this._layerManager.activate(layerId, enable);
    }

    mapFeature_(featureId)
    //====================
    {
        const ann = this._flatmap.annotation(featureId);
        if (ann !== undefined) {
            return {
                id: featureId,
                source: VECTOR_TILES_SOURCE,
                sourceLayer: this._flatmap.options.separateLayers
                             ? `${ann['layer']}_${ann['tile-layer']}`
                             : ann['tile-layer']
            };
        }
    }

    featureSelected_(featureId)
    //=========================
    {
        return this._selectedFeatureIds.has(+featureId);
    }

    selectFeature_(featureId, dim=true)
    //=================================
    {
        featureId = +featureId;   // Ensure numeric
        if (this._selectedFeatureIds.size === 0) {
            this._layerManager.setColour({...this.__colourOptions, dimmed: dim});
        }
        if (this._selectedFeatureIds.has(featureId)) {
            this._selectedFeatureIds.set(featureId, this._selectedFeatureIds.get(featureId) + 1);
        } else {
            const feature = this.mapFeature_(featureId);
            if (feature !== undefined) {
                this._map.setFeatureState(feature, { 'selected': true });
                this._selectedFeatureIds.set(featureId, 1);
            }
        }
    }

    unselectFeature_(featureId)
    //=========================
    {
        featureId = +featureId;   // Ensure numeric
        if (this._selectedFeatureIds.has(featureId)) {
            const references = this._selectedFeatureIds.get(featureId);
            if (references > 1) {
                this._selectedFeatureIds.set(featureId, references - 1);
            } else {
                const feature = this.mapFeature_(featureId);
                if (feature !== undefined) {
                    this._map.removeFeatureState(feature, 'selected');
                    this._selectedFeatureIds.delete(+featureId);
                }
            }
        }
        if (this._selectedFeatureIds.size === 0) {
            this._layerManager.setColour({...this.__colourOptions, dimmed: false});
        }
    }

    __unselectFeatures()
    //==================
    {
        for (const featureId of this._selectedFeatureIds.keys()) {
            const feature = this.mapFeature_(featureId);
            if (feature !== undefined) {
                this._map.removeFeatureState(feature, 'selected');
            }
        }
        this._selectedFeatureIds.clear();
        this._layerManager.setColour({...this.__colourOptions, dimmed: false});
    }

    activeFeaturesAtEvent_(event)
    //===========================
    {
        // Get the features covering the event's point that are in the active layers

        return this._map.queryRenderedFeatures(event.point).filter(f => {
            return (this.__enabledFeature(f)
                && this.activeLayerNames.indexOf(f.sourceLayer) >= 0)
                && ('featureId' in f.properties);
            }
        );
    }

    __activateFeature(feature)
    //=======================
    {
        if (feature !== undefined) {
            this._map.setFeatureState(feature, { active: true });
            this._activeFeatures.push(feature);
        }
    }

    resetActiveFeatures_()
    //====================
    {
        while (this._activeFeatures.length > 0) {
            this._map.removeFeatureState(this._activeFeatures.pop(), 'active');
        }
    }

    highlightFeature_(featureId)
    //==========================
    {
        featureId = +featureId;   // Ensure numeric
        this.__activateFeature(this.mapFeature_(featureId));
    }

    unhighlightFeatures_()
    //====================
    {
        this.resetActiveFeatures_();
    }

    smallestAnnotatedPolygonFeature_(features)
    //========================================
    {
        // Get the smallest feature from a list of features

        let smallestArea = 0;
        let smallestFeature = null;
        for (const feature of features) {
            if (feature.geometry.type.includes('Polygon')
             && this._map.getFeatureState(feature)['annotated']) {
                const polygon = turf.geometry(feature.geometry.type, feature.geometry.coordinates);
                const area = turfArea(polygon);
                if (smallestFeature === null || smallestArea > area) {
                    smallestFeature = feature;
                    smallestArea = area;
                }
            }
        }
        return smallestFeature;
    }

    contextMenuEvent_(event)
    //======================
    {
        event.preventDefault();

        // Chrome on Android sends both touch and contextmenu events
        // so ignore duplicate

        if (Date.now() < (this._lastContextTime + 100)) {
            return;
        }
        this._lastContextTime = Date.now();

        if (this._activeFeatures.length > 0) {
            const feature = this._activeFeatures[0];

            // Remove any tooltip
            this.removeTooltip_();

            const featureId = feature.id;
            if (this._pathways.isNode(featureId)) {
                const items = [
                    {
                        featureId: featureId,
                        prompt: 'Show paths',
                        action: this.enablePaths_.bind(this, true)
                    },
                    {
                        featureId: featureId,
                        prompt: 'Hide paths',
                        action: this.enablePaths_.bind(this, false)
                    }
                ];
                this.setModal_();
                this._contextMenu.show(event.lngLat, items, feature.properties.label);
            }
        }
    }

    setModal_(event)
    //==============
    {
        this._modal = true;
    }

    __clearModal(event)
    //=================
    {
        this._modal = false;
    }

    reset()
    //=====
    {
        this.__clearModal();
        this.clearActiveMarker_();
        this.__unselectFeatures();
        this.enablePathFeatures_(true, this._pathways.allFeatureIds());
        this._disabledPathFeatures = false;
    }

    clearSearchResults(reset=true)
    //============================
    {
        this.__unselectFeatures();
    }

    /**
     * Highlight features on the map.
     *
     * @param {Array.<string>}  featureIds  An array of feature identifiers to highlight
     */
    highlightFeatures(featureIds)
    //===========================
    {
        if (featureIds.length) {
            this.unhighlightFeatures_();
            for (const featureId of featureIds) {
                const annotation = this._flatmap.annotation(featureId);
                if (annotation) {
                    this.highlightFeature_(featureId);
                    if ('type' in annotation && annotation.type.startsWith('line')) {
                        for (const pathFeatureId of this._pathways.lineFeatureIds([featureId])) {
                            this.highlightFeature_(pathFeatureId);
                        }
                    }
                }
            }
        }
    }

    /**
     * Select features on the map.
     *
     * @param {Array.<string>}  featureIds  An array of feature identifiers to highlight
     */
    selectFeatures(featureIds)
    //========================
    {
        if (featureIds.length) {
            this.__unselectFeatures();
            for (const featureId of featureIds) {
                const annotation = this._flatmap.annotation(featureId);
                if (annotation) {
                    this.selectFeature_(featureId);
                    if ('type' in annotation && annotation.type.startsWith('line')) {
                        for (const pathFeatureId of this._pathways.lineFeatureIds([featureId])) {
                            this.selectFeature_(pathFeatureId);
                        }
                    }
                }
            }
        }
    }

    showSearchResults(featureIds)
    //===========================
    {
        this.zoomToFeatures(featureIds, {highlight: true, noZoomIn: true});
    }

    /**
     * Zoom map to features.
     *
     * @param      {Array.<string>}  featureIds   An array of feature identifiers
     * @param      {Object}  [options]
     * @param      {boolean} [options.select=true]  Select the features zoomed to
     * @param      {boolean} [options.highlight=false]  Highlight the features zoomed to
     * @param      {boolean} [options.noZoomIn=false]  Don't zoom in (although zoom out as necessary)
     * @param      {number}  [options.padding=10]  Padding in pixels around the composite bounding box
     */
    zoomToFeatures(featureIds, options=null)
    //======================================
    {
        options = utils.setDefaults(options, {
            select: true,
            highlight:
            false, noZoomIn:
            false, padding:10
        });
        const select = (options.select === true);
        const highlight = (options.highlight === true);
        if (featureIds.length) {
            this.unhighlightFeatures_();
            if (select) this.__unselectFeatures();
            let bbox = null;
            if (options.noZoomIn) {
                const bounds = this._map.getBounds().toArray();
                bbox = [...bounds[0], ...bounds[1]];
            }
            for (const featureId of featureIds) {
                const annotation = this._flatmap.annotation(featureId);
                if (annotation) {
                    if (select) {
                        this.selectFeature_(featureId);
                    } else if (highlight) {
                        this.highlightFeature_(featureId);
                    }
                    bbox = expandBounds(bbox, annotation.bounds);
                    if ('type' in annotation && annotation.type.startsWith('line')) {
                        for (const pathFeatureId of this._pathways.lineFeatureIds([featureId])) {
                            if (select) {
                                this.selectFeature_(pathFeatureId);
                            } else if (highlight) {
                                this.highlightFeature_(pathFeatureId);
                            }
                            const pathAnnotation = this._flatmap.annotation(pathFeatureId)
                            bbox = expandBounds(bbox, pathAnnotation.bounds);
                        }
                    }
                }
            }
            if (bbox !== null) {
                this._map.fitBounds(bbox, {
                    padding: options.padding,
                    animate: false
                });
            }
        }
    }

    showPopup(featureId, content, options={})
    //=======================================
    {
        const ann = this._flatmap.annotation(featureId);
        if (ann) {  // The feature exists

            // Remove any existing popup

            if (this._currentPopup) {
                this._currentPopup.remove();
            }

            // Highlight the feature

            this.__unselectFeatures();
            this.selectFeature_(featureId);

            // Find the pop-up's postion

            let location = null;
            if ('positionAtLastClick' in options
               && options.positionAtLastClick
               && this.__lastClickLngLat !== null) {
                location = this.__lastClickLngLat;
            } else {
                // Position popup at the feature's 'centre'
                location = this.__centralPosition(featureId, ann);
            }

            // Make sure the feature is on screen

            if (!this._map.getBounds().contains(location)) {
                this._map.panTo(location);
            }
            this.setModal_();
            this._currentPopup = new maplibre.Popup(options).addTo(this._map);
            this._currentPopup.on('close', this.__clearPopup.bind(this));
            this._currentPopup.setLngLat(location);
            if (typeof content === 'object') {
                this._currentPopup.setDOMContent(content);
            } else {
                this._currentPopup.setText(content);
            }
        }
    }

    __clearPopup()
    //============
    {
        this.__clearModal();
        this.__unselectFeatures();
    }

    removeTooltip_()
    //==============
    {
        if (this._tooltip) {
            this._tooltip.remove();
            this._tooltip = null;
        }
    }

    lineTooltip_(lineFeatures)
    //========================
    {
        const tooltips = [];
        for (const lineFeature of lineFeatures) {
            const properties = lineFeature.properties;
            if ('label' in properties
               && (!('tooltip' in properties) || properties.tooltip)
               && !('labelled' in properties)) {
                let tooltip = '';
                const label = properties.label;
                const cleanLabel = (label.substr(0, 1).toUpperCase() + label.substr(1)).replaceAll("\n", "<br/>");
                if (!tooltips.includes(cleanLabel)) {
                    tooltips.push(cleanLabel);
                }
            }
        }
        if (tooltips.length === 0) {
            return '';
        }
        return `<div class='flatmap-feature-label'>${tooltips.join('<hr/>')}</div>`;
    }

    tooltipHtml_(properties, forceLabel=false)
    //========================================
    {
        if (('label' in properties || 'hyperlink' in properties)
           && (forceLabel || !('tooltip' in properties) || properties.tooltip)
           && !('labelled' in properties)) {
            const label = ('label' in properties) ? (properties.label.substr(0, 1).toUpperCase()
                                                   + properties.label.substr(1)).replaceAll("\n", "<br/>")
                                                  : '';
            if ('hyperlink' in properties) {
                if (label === '') {
                    return `<div class='flatmap-feature-label'><a href='${properties.hyperlink}'>${properties.hyperlink}</a></div>`;
                } else {
                    return `<div class='flatmap-feature-label'><a href='${properties.hyperlink}'>${label}</a></div>`;
                }
            } else {
                return `<div class='flatmap-feature-label'>${label}</div>`;
            }
        }
        return '';
    }

    __featureEvent(type, feature)
    //===========================
    {
        if (feature.sourceLayer === PATHWAYS_LAYER) {  // I suspect this is never true as source layer
                                                       // names are like `neural_routes_pathways`
            return this._flatmap.featureEvent(type, this._pathways.pathProperties(feature));
        } else if ('properties' in feature) {
            return this._flatmap.featureEvent(type, feature.properties);
        }
        return false;
    }

    __resetFeatureDisplay()
    //=====================
    {
        // Remove any existing tooltip
        this.removeTooltip_();

        // Reset cursor
        this._map.getCanvas().style.cursor = 'default';

        // Reset any active features
        this.resetActiveFeatures_();
    }

    mouseMoveEvent_(event)
    //====================
    {
        // No tooltip when context menu is open
        if (this._modal) {
            return;
        }

        // Remove tooltip, reset active features, etc
        this.__resetFeatureDisplay();

        // Reset any info display
        const displayInfo = (this._infoControl && this._infoControl.active);
        if (displayInfo) {
            this._infoControl.reset()
        }

        // Get all the features at the current point
        const features = this._map.queryRenderedFeatures(event.point)
                             .filter(feature => this.__enabledFeature(feature));
        if (features.length === 0) {
            this._lastFeatureMouseEntered = null;
            this._lastFeatureModelsMouse = null;
            return;
        }

        // Simulate `mouseenter` events on features

        const feature = features[0];
        const featureModels = ('properties' in feature && 'models' in feature.properties)
                            ? feature.properties.models
                            : null;
        if (this._lastFeatureMouseEntered !== feature.id
         && (this._lastFeatureModelsMouse === null
          || this._lastFeatureModelsMouse !== featureModels)) {
            if (this.__featureEvent('mouseenter', feature)) {
                this._lastFeatureMouseEntered = feature.id;
                this._lastFeatureModelsMouse = featureModels;
            } else {
                this._lastFeatureMouseEntered = null;
                this._lastFeatureModelsMouse = null;
            }
        }

        let info = '';
        let tooltip = '';
        if (displayInfo) {
            if (!'tooltip' in features[0].properties) {
                this.__activateFeature(features[0]);
            }
            info = this._infoControl.featureInformation(features, event.lngLat);
        }
        const lineFeatures = features.filter(feature => ('centreline' in feature.properties
                                                      || ('type' in feature.properties
                                                        && feature.properties.type.startsWith('line')) ));
        if (lineFeatures.length > 0) {
            tooltip = this.lineTooltip_(lineFeatures);
            for (const lineFeature of lineFeatures) {
                const lineFeatureId = +lineFeature.properties.featureId;  // Ensure numeric
                this.__activateFeature(lineFeature);
                const lineIds = new Set(lineFeatures.map(f => f.properties.featureId));
                for (const featureId of this._pathways.lineFeatureIds(lineIds)) {
                    if (+featureId !== lineFeatureId) {
                        this.__activateFeature(this.mapFeature_(featureId));
                    }
                }
            }
        } else {
            let labelledFeatures = features.filter(feature => (('hyperlink' in feature.properties
                                                             || 'label' in feature.properties
                                                             || 'node' in feature.properties)
                                                         && (!('tooltip' in feature.properties)
                                                            || feature.properties.tooltip)))
                                           .sort((a, b) => (a.properties.area - b.properties.area));
            if (labelledFeatures.length > 0) {
                // Favour group features at low zoom levels
                const zoomLevel = this._map.getZoom();
                const groupFeatures = labelledFeatures.filter(feature => (feature.properties.group
                                                     && zoomLevel < (feature.properties.scale + 1)));
                if (groupFeatures.length > 0) {
                    labelledFeatures = groupFeatures;
                }
                const feature = labelledFeatures[0];
                tooltip = this.tooltipHtml_(feature.properties);
                if (this._flatmap.options.debug) {  // Do this when Info on and not debug??
                    const debugProperties = [
                        'featureId',
                        'nerveId',
                        'tile-layer',
                        'type',
                        ...displayedProperties
                    ];
                    const htmlList = [];
                    const featureIds = [];
                    for (const feature of labelledFeatures) {
                        if (featureIds.indexOf(feature.id) < 0) {
                            featureIds.push(feature.id);
                            for (const prop of debugProperties) {
                                if (prop in feature.properties) {
                                    htmlList.push(`<span class="info-name">${prop}:</span>`);
                                    htmlList.push(`<span class="info-value">${feature.properties[prop]}</span>`);
                                }
                            }
                        }
                        //htmlList.push(`<span class="info-name">Area:</span>`);
                        //htmlList.push(`<span class="info-value">${feature.properties.area/1000000000}</span>`);
                        //htmlList.push(`<span class="info-name">Scale:</span>`);
                        //htmlList.push(`<span class="info-value">${feature.properties.scale}</span>`);
                    }
                    info = `<div id="info-control-info">${htmlList.join('\n')}</div>`;
                }
                this.__activateFeature(feature);
                this.__activateRelatedFeatures(feature);
                if ('hyperlink' in feature.properties) {
                    this._map.getCanvas().style.cursor = 'pointer';
                }
            }
        }

        if (displayInfo || this._flatmap.options.debug) {
            this._infoControl.show(info);
        }
        this.__showToolTip(tooltip, event.lngLat);
    }

    __showToolTip(html, lngLat)
    //=========================
    {
        // Show a tooltip
        if (html !== '') {
            this._tooltip = new maplibre.Popup({
                closeButton: false,
                closeOnClick: false,
                maxWidth: 'none',
                className: 'flatmap-tooltip-popup'
            });
            if (this._flatmap.options.showPosition) {
                const pt = turf.point(lngLat.toArray());
                const gps = turfProjection.toMercator(pt);
                const coords = gps.geometry.coordinates;
                html = `<span>${JSON.stringify(coords)}</span><br/>${html}`;
            }
            this._tooltip
                .setLngLat(lngLat)
                .setHTML(html)
                .addTo(this._map);
        }
    }

    selectionEvent_(event, feature)
    //=============================
    {
        if (feature !== undefined) {
            const clickedFeatureId = feature.id;
            const dim = !('properties' in feature
                       && 'kind' in feature.properties
                       && ['cell-type', 'scaffold', 'tissue'].indexOf(feature.properties.kind) >= 0);
            if (!(event.ctrlKey || event.metaKey)) {
                let selecting = true;
                for (const featureId of this._selectedFeatureIds.keys()) {
                    if (featureId === clickedFeatureId) {
                        selecting = false;
                        break;
                    }
                }
                this.__unselectFeatures();
                if (selecting) {
                    for (const feature of this._activeFeatures) {
                        this.selectFeature_(feature.id, dim);
                    }
                }
            } else {
                const clickedSelected = this.featureSelected_(clickedFeatureId);
                for (const feature of this._activeFeatures) {
                    if (clickedSelected) {
                        this.unselectFeature_(feature.id);
                    } else {
                        this.selectFeature_(feature.id, dim);
                    }
                }
            }
        }
    }

    clickEvent_(event)
    //================
    {
        this.clearActiveMarker_();
        const clickedFeatures = this._map.queryRenderedFeatures(event.point);
        if (clickedFeatures.length == 0){
            this.__unselectFeatures();
            return;
        }
        const clickedFeature = clickedFeatures[0];
        const originalEvent = event.originalEvent;
        this.selectionEvent_(originalEvent, clickedFeature);
        if (this._modal) {
           // Remove tooltip, reset active features, etc
            this.__resetFeatureDisplay();
            this.__unselectFeatures();
            this.__clearModal();
        } else if (clickedFeature !== undefined) {
            this.__lastClickLngLat = event.lngLat;
            this.__featureEvent('click', clickedFeature);
            if ('properties' in clickedFeature && 'hyperlink' in clickedFeature.properties) {
                window.open(clickedFeature.properties.hyperlink, '_blank');
            }
        }
    }

    __activateRelatedFeatures(feature)
    //================================
    {
        if ('nerveId' in feature.properties) {
            for (const featureId of this._pathways.nerveFeatureIds(feature.properties.nerveId)) {
                this.__activateFeature(this.mapFeature_(featureId));
            }
        }
        if ('nodeId' in feature.properties) {
            for (const featureId of this._pathways.nodeFeatureIds(feature.properties.nodeId)) {
                this.__activateFeature(this.mapFeature_(featureId));
            }
        }
    }

    __enabledFeature(feature)
    //=======================
    {
        const state = this._map.getFeatureState(feature);
        return (state !== undefined
            && (!('hidden' in state) || !state.hidden));
    }

    enablePaths_(enable, event)
    //=========================
    {
        this._contextMenu.hide();
        const nodeId = event.target.getAttribute('featureId');
        this.enablePathFeatures_(enable, this._pathways.pathFeatureIds(nodeId));
        this.__clearModal();
    }

    enablePathFeatures_(enable, featureIds)
    //=====================================
    {
        for (const featureId of featureIds) {
            const feature = this.mapFeature_(featureId);
            if (feature !== undefined) {
                if (enable) {
                    this._map.removeFeatureState(feature, 'hidden');
                } else {
                    this._map.setFeatureState(feature, { 'hidden': true });
                    this._disabledPathFeatures = true;
                }
            }
        }
    }

    togglePaths()
    //===========
    {
        if (this._disabledPathFeatures){
            this.enablePathFeatures_(true, this._pathways.allFeatureIds());
            this._disabledPathFeatures = false;
        } else {
            this.enablePathFeatures_(false, this._pathways.allFeatureIds());
        }
    }

    enablePath(pathType, enable=true)
    //===============================
    {
        this.enablePathFeatures_(enable, this._pathways.typeFeatureIds(pathType));
    }

    showPaths(pathTypes, enable=true)
    //===============================
    {
        // Disable/enable all paths except those with `pathTypes`
        if (Array.isArray(pathTypes)) {
            for (const pathType of pathways.pathTypes) {
                if (pathTypes.indexOf(pathType.type) >= 0) {
                    this.enablePath(pathType.type, enable)
                } else {
                    this.enablePath(pathType.type, !enable)
                }
            }
        } else {
            for (const pathType of pathways.pathTypes) {
                if (pathType.type === pathTypes) {
                    this.enablePath(pathType.type, enable)
                } else {
                    this.enablePath(pathType.type, !enable)
                }
            }
        }
    }

    pathwaysFeatureIds(externalIds)
    //=============================
    {
        const featureIds = new utils.List();
        featureIds.extend(this._pathways.connectivityModelFeatureIds(externalIds));
        featureIds.extend(this._pathways.pathModelFeatureIds(externalIds));
        return featureIds;
    }

    nodePathModels(nodeId)
    //====================
    {
        return this._pathways.nodePathModels(nodeId);
    }

    showSckanPaths(state='valid')
    //===========================
    {
        this._layerManager.setFilter({sckan: state});
    }

    //==============================================================================

    // Find where to place a label or popup on a feature

    __centralPosition(featureId, annotation)
    //======================================
    {
        if (this.__centralPositions.has(featureId)) {
            return this.__centralPositions.get(featureId);
        }
        let position = annotation.centroid;
        const features = this._map.querySourceFeatures(VECTOR_TILES_SOURCE, {
            'sourceLayer': this._flatmap.options.separateLayers
                            ? `${annotation['layer']}_${annotation['tile-layer']}`
                            : annotation['tile-layer'],
            'filter': [
                'all',
                [ '==', ['id'], parseInt(featureId) ],
                [ '==', ['geometry-type'], 'Polygon' ]
            ]
        });
        if (features.length > 0) {
            const feature = features[0];
            const polygon = feature.geometry.coordinates;
            // Rough heuristic. Area is in km^2; below appears to be good enough.
            const precision = ('area' in feature.properties)
                                ? Math.sqrt(feature.properties.area)/500000
                                : 0.1;
            position = polylabel(polygon, precision);
        }
        this.__centralPositions.set(featureId, position);
        return position;
    }

    //==============================================================================

    // Marker handling

    addMarker(anatomicalId, htmlElement=null)
    //=======================================
    {
        const featureIds = this._flatmap.modelFeatureIds(anatomicalId);
        let markerId = -1;

        for (const featureId of featureIds) {
            const annotation = this._flatmap.annotation(featureId);
            if (annotation.geometry.indexOf('Polygon') < 0) {
                continue;
            }
            if (!('marker' in annotation)) {
                if (markerId === -1) {
                    this.__lastMarkerId += 1;
                    markerId = this.__lastMarkerId;
                }

                // MapLibre dynamically sets a transform on marker elements so in
                // order to apply a scale transform we need to create marker icons
                // inside the marker container <div>.
                const markerHTML = htmlElement ? new maplibre.Marker({elment: htmlElement})
                                               : new maplibre.Marker();

                const markerElement = document.createElement('div');
                const markerIcon = document.createElement('div');
                markerIcon.innerHTML = markerHTML.getElement().innerHTML;
                markerIcon.className = 'flatmap-marker';
                markerElement.appendChild(markerIcon);

                const markerPosition = (annotation.geometry === 'Polygon')
                                     ? this.__centralPosition(featureId, annotation)
                                     : annotation.centroid;
                const marker = new maplibre.Marker(markerElement)
                                           .setLngLat(markerPosition)
                                           .addTo(this._map);
                markerElement.addEventListener('mouseenter',
                    this.markerMouseEvent_.bind(this, marker, anatomicalId));
                markerElement.addEventListener('mousemove',
                    this.markerMouseEvent_.bind(this, marker, anatomicalId));
                markerElement.addEventListener('mouseleave',
                    this.markerMouseEvent_.bind(this, marker, anatomicalId));
                markerElement.addEventListener('click',
                    this.markerMouseEvent_.bind(this, marker, anatomicalId));

                this.__markerIdByMarker.set(marker, markerId);
                this.__annotationByMarkerId.set(markerId, annotation);
            }
        }
        if (markerId === -1) {
            console.warn(`Unable to find feature '${anatomicalId}' on which to place marker`)
        }
        return markerId;
    }

    clearMarkers()
    //============
    {
        for (const marker of this.__markerIdByMarker.keys()) {
            marker.remove();
        }
        this.__markerIdByMarker.clear();
        this.__annotationByMarkerId.clear();
    }

    removeMarker(markerId)
    //====================
    {
        for (const [marker, id] of this.__markerIdByMarker.entries()) {
            if (markerId === id) {
                marker.remove();
                this.__markerIdByMarker.remove(marker);
                this.__annotationByMarkerId.remove(id);
                break;
            }
        }
    }

    visibleMarkerAnatomicalIds()
    //==========================
    {
        const anatomicalIds = [];
        const visibleBounds = this._map.getBounds();
        for (const [marker, id] of this.__markerIdByMarker.entries()) {
            if (visibleBounds.contains(marker.getLngLat())) {
                const annotation = this.__annotationByMarkerId.get(id);
                if (anatomicalIds.indexOf(annotation.models) < 0) {
                    anatomicalIds.push(annotation.models);
                }
            }
        }
        return anatomicalIds;
    }

    markerMouseEvent_(marker, anatomicalId, event)
    //============================================
    {
        // No tooltip when context menu is open
        if (this._modal
         || (this.__activeMarker !== null && event.type === 'mouseleave')) {
            return;
        }

        if (['mouseenter', 'mouseleave', 'click'].indexOf(event.type) >= 0) {
            this.__activeMarker = marker;

            // Remove any existing tooltips
            this.removeTooltip_();
            marker.setPopup(null);

            // Reset cursor
            marker.getElement().style.cursor = 'default';

            if (['mouseenter', 'click'].indexOf(event.type) >= 0) {
                const markerId = this.__markerIdByMarker.get(marker);
                const annotation = this.__annotationByMarkerId.get(markerId);
                // The marker's feature
                const feature = this.mapFeature_(annotation.featureId);
                if (feature !== undefined) {
                    if (event.type === 'mouseenter') {
                        // Highlight on mouse enter
                        this.resetActiveFeatures_();
                        this.__activateFeature(feature);
                    } else {
                        this.selectionEvent_(event, feature)
                    }
                }
                // Show tooltip
                const html = this.tooltipHtml_(annotation, true);
                this.__showToolTip(html, marker.getLngLat());

                // Send marker event message
                this._flatmap.markerEvent(event.type, markerId, anatomicalId);
            }
        }
        event.stopPropagation();
    }

    clearActiveMarker_()
    //==================
    {
        if (this.__activeMarker !== null) {
            this.__activeMarker.setPopup(null);
            this.__activeMarker = null;
        }
    }

    showMarkerPopup(markerId, content, options)
    //=========================================
    {
        const marker = this.__activeMarker;
        if (markerId !== this.__markerIdByMarker.get(marker)) {
            this.clearActiveMarker_();
            return false;
        }

        const location = marker.getLngLat();

        // Make sure the marker is on screen

        if (!this._map.getBounds().contains(location)) {
            this._map.panTo(location);
        }

        const element = document.createElement('div');
        if (typeof content === 'object') {
            element.appendChild(content);
        } else {
            element.innerHTML = content;
        }

        element.addEventListener('click', e => this.clearActiveMarker_());

        this._tooltip = new maplibre.Popup({
            closeButton: false,
            closeOnClick: false,
            maxWidth: 'none',
            className: 'flatmap-marker-popup'
        });

        this._tooltip
            .setLngLat(location)
            .setDOMContent(element);

        // Set the merker tooltip and show it
        marker.setPopup(this._tooltip);
        marker.togglePopup();

        return true;
    }

    enablePanZoomEvents(enabled=true)
    //===============================
    {
        this.__pan_zoom_enabled = enabled;
    }

    panZoomEvent_(type)
    //=================
    {
        if (this.__pan_zoom_enabled) {
            this._flatmap.panZoomEvent(type);
        }
    }
}

//==============================================================================
