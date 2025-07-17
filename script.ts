// Import MapLibre GL JS
import maplibregl from 'maplibre-gl';

// const api = "http://192.168.1.90:3000/tk"
const api = "https://api.abetterride.app/tk"

// Types for the vehicle data
interface Vehicle {
    vehicle_id: string;
    trip_id: string;
    location?: {
        lat: number;
        lng: number;
    };
    route_color: string;
    text_color: string;
    route_short_name: string;
    route_long_name: string;
    headsign: string;
    bearing?: number;
}

interface VisualMapResponse {
    vehicles: Vehicle[];
    old_vehicles: Vehicle[];
}

interface VisualVehicleResponse {
    agency_display_name: string;
    shape: Array<{ lat: number; lng: number }>;
    route_type: string;
}

interface marker {
    marker: maplibregl.Marker;
    vehicle: Vehicle;
    animationId?: number;
}

// Simple animation helper for smooth marker movement
class MarkerAnimator {
    private startTime: number = 0;
    private startLngLat: [number, number] = [0, 0];
    private endLngLat: [number, number] = [0, 0];
    private duration: number = 60000; // 60 seconds
    private marker: maplibregl.Marker;
    private animationId: number | null = null;
    private isAnimating: boolean = false;

    constructor(marker: maplibregl.Marker) {
        this.marker = marker;
    }

    slideTo(lngLat: [number, number], duration: number = 60000): void {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
        }

        this.startTime = Date.now();
        this.startLngLat = this.marker.getLngLat().toArray() as [number, number];
        this.endLngLat = lngLat;
        this.duration = duration;
        this.isAnimating = true;

        this.animate();
    }

    private animate = (): void => {
        if (!this.isAnimating) return;

        const elapsed = Date.now() - this.startTime;
        const progress = Math.min(elapsed / this.duration, 1);

        // Easing function for smooth animation
        const easeProgress = progress < 0.5
            ? 2 * progress * progress
            : 1 - Math.pow(-2 * progress + 2, 3) / 2;

        const currentLng = this.startLngLat[0] + (this.endLngLat[0] - this.startLngLat[0]) * easeProgress;
        const currentLat = this.startLngLat[1] + (this.endLngLat[1] - this.startLngLat[1]) * easeProgress;

        this.marker.setLngLat([currentLng, currentLat]);

        if (progress < 1) {
            this.animationId = requestAnimationFrame(this.animate);
        } else {
            this.isAnimating = false;
            this.animationId = null;
        }
    };

    stop(): void {
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        this.isAnimating = false;
    }
}

// Coords
interface place {
    center: [number, number];
    zoom: number;
    name: string;
}

const SF: place = {
    center: [-122.43332887350739, 37.7665252509697],
    zoom: 12,
    name: "SF"
};

const BAYAREA: place = {
    center: [-122.26666379640395, 37.65959600564773],
    zoom: 10,
    name: "BAYAREA"
};

const NYC: place = {
    center: [-73.96204603887533, 40.76983974255722],
    zoom: 10,
    name: "NYC"
};

const USA: place = {
    center: [-98.47252196050131, 38.934262001940496],
    zoom: 5,
    name: "USA" // not a real name, USA is just for initial map location
};

class MapApplication {
    private markers: Record<string, marker> = {};
    private animators: Record<string, MarkerAnimator> = {};
    private selectedVehicle: Vehicle | undefined = undefined;
    private routeLayerId: string | null = null;
    private selectedSchedule: VisualVehicleResponse | undefined = undefined;
    private routeArrows: maplibregl.Marker[] = [];

    private place: place = USA;
    private map: maplibregl.Map;

    private userActive: boolean = true;
    private lastUpdatedAt: Date | undefined = undefined;

    constructor(mapElementId: string) {
        // Setup the map
        this.map = new maplibregl.Map({
            container: mapElementId,
            style: {
                version: 8,
                sources: {
                    'carto-light': {
                        type: 'raster',
                        tiles: [
                            'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
                            'https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
                            'https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
                            'https://d.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png'
                        ],
                        tileSize: 256,
                        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a> Data provided by <a href="https://511.org/">511.org</a> and <a href="https://www.mta.info/">MTA</a>'
                    }
                },
                layers: [
                    {
                        id: 'carto-light-layer',
                        type: 'raster',
                        source: 'carto-light'
                    }
                ]
            },
            center: this.place.center,
            zoom: this.place.zoom,
            attributionControl: {
                compact: false,
            }
        });

        // Set up map reset (not clear)
        this.map.on('click', (e) => {
            this.showAllMarkers();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.showAllMarkers();
            }
        });

        // Set URL
        this.setPlace();
        window.addEventListener('hashchange', (event) => {
            if (this.setPlace() && this.lastUpdatedAt) {
                this.fetchAndUpdate(true);
            }
        });

        // Only fetch if user is active
        document.addEventListener("visibilitychange", () => {
            if (document.hidden) {
                this.userActive = false;
            } else if (this.lastUpdatedAt) {
                this.userActive = true;
                // if it has been more than 2 minutes, replace the markers instead of moving them
                const replace = Math.abs(new Date().getTime() - this.lastUpdatedAt.getTime()) > 2 * 60 * 1000;
                this.fetchAndUpdate(replace);
            }
        });

        // Wait for map to load before fetching data
        this.map.on('load', () => {
            this.fetchAndUpdate(true);
            setInterval(() => this.fetchAndUpdate(false), 60000);
        });
    }

    private setPlace(): boolean {
        switch (window.location.hash) {
            case "#SF":
                this.map.flyTo({ center: SF.center, zoom: SF.zoom, duration: 2500, essential: true });
                this.place = SF;
                this.fetchAndUpdate(true);
                return true;
            case "#BAYAREA":
                this.map.flyTo({ center: BAYAREA.center, zoom: BAYAREA.zoom, duration: 2500, essential: true });
                this.place = BAYAREA;
                this.fetchAndUpdate(true);
                return true;
            case "#NYC":
                this.map.flyTo({ center: NYC.center, zoom: NYC.zoom, duration: 2500, essential: true });
                this.place = NYC;
                this.fetchAndUpdate(true);
                return true;
        }
        return false;
    }

    private async fetchAndUpdate(replaceAndFetchOld: boolean): Promise<void> {
        if (!this.userActive) {
            return;
        }

        document.getElementById("info")?.classList.add("is-loading");

        try {
            // Hi! Don't be scraping please, use 511.org's data directly. It's free!
            const res = await fetch(api + '/visualMap', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ place: this.place.name, include_old: replaceAndFetchOld })
            });

            if (!res.ok) {
                // Try to get the error response body
                let errorText;
                try {
                    errorText = await res.text();
                } catch (textError) {
                    errorText = 'Could not read error response';
                }

                console.error('HTTP Error:', {
                    status: res.status,
                    statusText: res.statusText,
                    url: res.url,
                    headers: Object.fromEntries(res.headers.entries()),
                    body: errorText
                });

                throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            }

            const data: VisualMapResponse = await res.json();
            if (replaceAndFetchOld) {
                this.clearMarkers();
            }
            if (replaceAndFetchOld) {
                this.updateVehicles(data.old_vehicles);
                await new Promise(r => setTimeout(r, 1000)); // pause so the old location settles
            }
            this.updateVehicles(data.vehicles);
            document.getElementById("info")?.classList.remove("is-loading");
        } catch (err) {
            console.error('Fetch error', err);
        }
    }

    private clearMarkers(): void {
        Object.values(this.markers).forEach(m => {
            m.marker.remove();
            if (this.animators[this.key(m.vehicle)]) {
                this.animators[this.key(m.vehicle)].stop();
                delete this.animators[this.key(m.vehicle)];
            }
        });
        this.markers = {};
    }

    private key(v: Vehicle): string {
        return v.vehicle_id + v.trip_id;
    }

    private updateVehicles(vehicles: Vehicle[]): void {
        const incomingVehicles = new Set<string>();

        vehicles.forEach(vehicle => {
            if (!vehicle.location) return;

            incomingVehicles.add(this.key(vehicle));
            const newPos: [number, number] = [vehicle.location.lng, vehicle.location.lat];

            if (this.markers[this.key(vehicle)]) {
                const markerData = this.markers[this.key(vehicle)];
                const animator = this.animators[this.key(vehicle)];
                if (animator) {
                    animator.slideTo(newPos, 60000);
                }
                // Update vehicle data
                markerData.vehicle = vehicle;
            } else {
                this.createMarker(vehicle, newPos);
            }
        });

        // Remove markers for vehicles no longer present
        Object.keys(this.markers).forEach(id => {
            if (!incomingVehicles.has(id)) {
                this.markers[id].marker.remove();
                if (this.animators[id]) {
                    this.animators[id].stop();
                    delete this.animators[id];
                }
                delete this.markers[id];
            }
        });
        this.lastUpdatedAt = new Date();
    }

    private createMarker(vehicle: Vehicle, position: [number, number]): void {
        // Create the element directly instead of using innerHTML
        const el = document.createElement('div');
        el.className = 'vehicle-icon';
        el.style.cssText = `
            background: #${vehicle.route_color};
            color: #${vehicle.text_color};
            cursor: pointer;
            z-index: 100;
        `;

        // Add the route name
        const routeText = document.createElement('span');
        routeText.textContent = vehicle.route_short_name;
        el.appendChild(routeText);

        // Add bearing arrow if available
        if (vehicle.bearing) {
            const arrow = document.createElement('ion-icon');
            arrow.setAttribute('name', 'arrow-up-circle-outline');
            arrow.style.cssText = `
                display: inline-block;
                width: 14px;
                height: 14px;
                flex-shrink: 0;
                transform: rotate(${vehicle.bearing}deg);
                margin-left: 4px;
            `;
            el.appendChild(arrow);
        }

        const marker = new maplibregl.Marker({ element: el })
            .setLngLat(position)
            .addTo(this.map);

        // Create animator for this marker
        const animator = new MarkerAnimator(marker);
        this.animators[this.key(vehicle)] = animator;

        // Add click event
        el.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (this.selectedVehicle) {
                this.showAllMarkers();
            } else {
                this.hideSomeMarkers(vehicle.headsign, vehicle.route_short_name);
                this.selectedVehicle = vehicle;
                try {
                    // Hi! Don't be scraping please, use 511.org's data directly. It's free!
                    const res = await fetch(api + '/visualVehicle', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ trip_id: vehicle.trip_id })
                    });

                    if (!res.ok) {
                        // Try to get the error response body
                        let errorText;
                        try {
                            errorText = await res.text();
                        } catch (textError) {
                            errorText = 'Could not read error response';
                        }

                        console.error('HTTP Error:', {
                            status: res.status,
                            statusText: res.statusText,
                            url: res.url,
                            headers: Object.fromEntries(res.headers.entries()),
                            body: errorText
                        });

                        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
                    }

                    const data: VisualVehicleResponse = await res.json();
                    this.selectedSchedule = data;
                    this.updateScheduleDisplay();
                    this.drawRouteShape(vehicle.route_color, data.shape);
                } catch (err) {
                    console.error('Fetch shape error', err);
                }
            }
        });

        this.markers[this.key(vehicle)] = {
            marker: marker,
            vehicle: vehicle,
        };

        // If there is a marker selected, don't display (should be after adding it to map)
        if (this.selectedVehicle) {
            if (vehicle.headsign !== this.selectedVehicle.headsign || vehicle.route_short_name !== this.selectedVehicle.route_short_name) {
                el.style.display = 'none';
            }
        }
    }

    private hideSomeMarkers(headsign: string, route_short_name: string): void {
        Object.entries(this.markers).forEach(([_, data]) => {
            if (data.vehicle.headsign !== headsign || data.vehicle.route_short_name !== route_short_name) {
                const elem = data.marker.getElement();
                if (elem) {
                    elem.style.display = 'none';
                }
            }
        });
    }

    private showAllMarkers(): void {
        Object.entries(this.markers).forEach(([_, data]) => {
            const elem = data.marker.getElement();
            if (elem) {
                elem.style.display = '';
            }
        });
        this.selectedVehicle = undefined;
        this.selectedSchedule = undefined;
        this.updateScheduleDisplay();
        this.clearRouteShapes();
    }

    private drawRouteShape(route_color: string, shape: Array<{ lat: number; lng: number }>): void {
        if (!shape || shape.length === 0) {
            return;
        }

        // Remove existing route layer if it exists
        this.clearRouteShapes();

        const coordinates = shape.map(point => [point.lng, point.lat]);

        // Create a unique layer ID
        this.routeLayerId = `route-${Date.now()}`;

        // Add the route source
        this.map.addSource(this.routeLayerId, {
            type: 'geojson',
            data: {
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'LineString',
                    coordinates: coordinates
                }
            }
        });

        // Add the route layer
        this.map.addLayer({
            id: this.routeLayerId,
            type: 'line',
            source: this.routeLayerId,
            layout: {
                'line-join': 'round',
                'line-cap': 'round'
            },
            paint: {
                'line-color': `#${route_color}`,
                'line-width': 4,
                'line-opacity': 0.8
            }
        });

        // Add arrows along the route
        this.addArrowsToRoute(route_color, shape);
    }

    private addArrowsToRoute(route_color: string, shape: Array<{ lat: number; lng: number }>): void {
        let totalDistance = 0;
        const arrowSpacing = 1000; // meters between arrows

        for (let i = 0; i < shape.length - 1; i++) {
            const segmentDistance = this.calculateDistance(shape[i], shape[i + 1]);

            if (totalDistance >= arrowSpacing) {
                const bearing = this.calculateBearing(shape[i], shape[i + 1]);

                const arrowEl = document.createElement('div');
                arrowEl.innerHTML = `<div style="transform: rotate(${bearing - 90}deg); opacity: .8;">➜</div>`;
                arrowEl.style.cssText = `
                    color: #${route_color};
                    font-size: 16px;
                    transform: rotate(${bearing}deg);
                    pointer-events: none;
                `;

                const arrowMarker = new maplibregl.Marker({ element: arrowEl })
                    .setLngLat([shape[i].lng, shape[i].lat])
                    .addTo(this.map);
                this.routeArrows.push(arrowMarker)

                totalDistance = 0;
            } else {
                totalDistance += segmentDistance;
            }
        }
    }

    private calculateDistance(coord1: { lat: number; lng: number }, coord2: { lat: number; lng: number }): number {
        // Simple distance calculation in meters
        const R = 6371000; // Earth's radius in meters
        const dLat = (coord2.lat - coord1.lat) * Math.PI / 180;
        const dLon = (coord2.lng - coord1.lng) * Math.PI / 180;
        const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(coord1.lat * Math.PI / 180) * Math.cos(coord2.lat * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    private calculateBearing(start: { lat: number; lng: number }, end: { lat: number; lng: number }): number {
        const dLng = end.lng - start.lng;
        const dLat = end.lat - start.lat;
        return Math.atan2(dLng, dLat) * 180 / Math.PI;
    }

    private updateScheduleDisplay(): void {
        const scheduleContent = document.getElementById('schedule-content');

        if (scheduleContent) {
            if (this.selectedSchedule && this.selectedVehicle) {
                scheduleContent.innerHTML = `
                    <div class="card">
                        <div class="badge" style="background-color:#${this.selectedVehicle.route_color};">
                            <div class="text" style="color:#${this.selectedVehicle.text_color};">${this.selectedVehicle.route_short_name}</div>
                            ${this.selectedVehicle.bearing ? `<ion-icon name="arrow-up-circle-outline" style="display: inline-block; width: 18px; height: 18px; flex-shrink: 0; transform: rotate(${this.selectedVehicle.bearing}deg); margin-left: 4px; color:#${this.selectedVehicle.text_color};"></ion-icon>` : ""}
                        </div>
                        <div class="info">
                            <div class="headsign line">${this.selectedVehicle.headsign}</div>
                            <div class="long-name line">${this.selectedVehicle.route_long_name}</div>
                            <div class="operator line">${this.selectedSchedule.route_type} operated by ${this.selectedSchedule.agency_display_name}</div>
                        </div>
                    </div>
                `;
            } else {
                scheduleContent.innerHTML = '';
            }
        }
    }

    // Method to clear all route shapes
    private clearRouteShapes(): void {
        if (this.routeLayerId && this.map.getLayer(this.routeLayerId)) {
            this.map.removeLayer(this.routeLayerId);
            this.map.removeSource(this.routeLayerId);
            this.routeLayerId = null;
        }

        // Clear route arrows
        this.routeArrows.forEach(arrow => arrow.remove());
        this.routeArrows = [];
    }
}

// Initialize the application when the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    const app = new MapApplication('map');
});

// For the app icon interaction
document.addEventListener('DOMContentLoaded', () => {
    const appDiv = document.getElementById('app');
    const infoDiv = appDiv?.querySelector('.info') as HTMLElement;

    if (!appDiv || !infoDiv) {
        console.error('App div or info div not found');
        return;
    }

    // Show info on mouse enter
    appDiv.addEventListener('mouseenter', () => {
        infoDiv.style.display = 'flex';
    });

    // Hide info on mouse leave
    appDiv.addEventListener('mouseleave', () => {
        infoDiv.style.display = 'none';
    });
});

// Info toggle functionality
document.addEventListener('DOMContentLoaded', () => {
    const toggleIcon: HTMLElement | null = document.getElementById('toggle-icon');
    let isExpanded: boolean = false;

    toggleIcon?.addEventListener('click', function (): void {
        console.log('Icon clicked! Current state:', isExpanded ? 'expanded' : 'contracted');

        if (isExpanded) {
            toggleIcon.setAttribute('name', 'contract-outline');
            isExpanded = false;
        } else {
            toggleIcon.setAttribute('name', 'expand-outline');
            isExpanded = true;
        }
    });
});