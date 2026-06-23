// DMAMapView.swift
// Drop-in SwiftUI view — shows a pin at the animal location + DMA polygon overlays.
// Target: iOS 17+ (uses new Map/MapContentBuilder API)
// Dependencies: MapKit, SwiftUI, CoreLocation (all built-in)
//
// USAGE:
//   DMAMapView(latitude: 40.8, longitude: -77.5)
//
// HOW IT WORKS:
//   1. Centers map on the given coordinates with a pin annotation.
//   2. Fetches nearby active DMA polygons from the PGC FeatureServer 300 REST API.
//   3. Renders DMA boundaries as semi-transparent colored overlays on the map.
//   4. Shows a banner indicating whether the pin is inside a DMA.
//
// API DETAILS:
//   Endpoint: https://services1.arcgis.com/k8yxvICm95iIFicb/arcgis/rest/services/CWD/FeatureServer/300/query
//   - geometry param: envelope (bbox) around the pin ±0.5°
//   - where: dma_status='A' (active DMAs only)
//   - outSR=4326 returns coordinates as [longitude, latitude] pairs
//   - returnGeometry=true returns polygon ring arrays
//   - No authentication required (public endpoint)

import SwiftUI
import MapKit
import CoreLocation

// MARK: - Data Models

/// Represents a single DMA polygon with its metadata
struct DMAZone: Identifiable {
    let id = UUID()
    let name: String
    let number: Int
    let coordinates: [[CLLocationCoordinate2D]] // Multiple rings per polygon
    
    /// Color for this DMA zone (color-coded by DMA number)
    var color: Color {
        let colors: [Color] = [.red, .orange, .yellow, .green, .blue, .purple, .pink, .brown, .cyan, .mint]
        let index = (number - 1) % colors.count
        return colors[index]
    }
}

// MARK: - Codable Response Models (Esri JSON format)

private struct EsriQueryResponse: Codable {
    let features: [EsriFeature]?
}

private struct EsriFeature: Codable {
    let attributes: EsriAttributes
    let geometry: EsriGeometry?
}

private struct EsriAttributes: Codable {
    let dma_name: String?
    let dma: Int?
}

private struct EsriGeometry: Codable {
    let rings: [[[Double]]]? // Array of rings; each ring is array of [lon, lat] pairs
}

// MARK: - DMA Polygon Fetch Service

/// Fetches DMA polygon geometries for a given bounding box
actor DMAPolygonService {
    
    enum DMAPolygonError: Error {
        case invalidURL
        case networkError(Error)
        case decodingError(Error)
    }
    
    /// Fetch active DMA polygons near the given coordinates (±0.5° bounding box)
    func fetchNearbyDMAs(latitude: Double, longitude: Double) async throws -> [DMAZone] {
        let minLon = longitude - 0.5
        let minLat = latitude - 0.5
        let maxLon = longitude + 0.5
        let maxLat = latitude + 0.5
        
        // Build URL with envelope geometry (bounding box)
        var components = URLComponents(string: "https://services1.arcgis.com/k8yxvICm95iIFicb/arcgis/rest/services/CWD/FeatureServer/300/query")!
        components.queryItems = [
            URLQueryItem(name: "geometry", value: "\(minLon),\(minLat),\(maxLon),\(maxLat)"),
            URLQueryItem(name: "geometryType", value: "esriGeometryEnvelope"),
            URLQueryItem(name: "inSR", value: "4326"),
            URLQueryItem(name: "spatialRel", value: "esriSpatialRelIntersects"),
            URLQueryItem(name: "where", value: "dma_status='A'"),
            URLQueryItem(name: "outFields", value: "dma_name,dma"),
            URLQueryItem(name: "outSR", value: "4326"),
            URLQueryItem(name: "returnGeometry", value: "true"),
            URLQueryItem(name: "f", value: "json")
        ]
        
        guard let url = components.url else {
            throw DMAPolygonError.invalidURL
        }
        
        let data: Data
        do {
            let (responseData, _) = try await URLSession.shared.data(from: url)
            data = responseData
        } catch {
            throw DMAPolygonError.networkError(error)
        }
        
        let response: EsriQueryResponse
        do {
            response = try JSONDecoder().decode(EsriQueryResponse.self, from: data)
        } catch {
            throw DMAPolygonError.decodingError(error)
        }
        
        guard let features = response.features else { return [] }
        
        // Convert Esri features to DMAZone models
        var zones: [DMAZone] = []
        for feature in features {
            guard let rings = feature.geometry?.rings else { continue }
            let name = feature.attributes.dma_name ?? "Unknown DMA"
            let number = feature.attributes.dma ?? 0
            
            // Convert [lon, lat] pairs to CLLocationCoordinate2D
            let coordinateRings: [[CLLocationCoordinate2D]] = rings.map { ring in
                ring.compactMap { pair in
                    guard pair.count >= 2 else { return nil }
                    return CLLocationCoordinate2D(latitude: pair[1], longitude: pair[0])
                }
            }
            
            // Only add if we have valid coordinates
            if !coordinateRings.isEmpty && coordinateRings.contains(where: { !$0.isEmpty }) {
                zones.append(DMAZone(name: name, number: number, coordinates: coordinateRings))
            }
        }
        
        return zones
    }
    
    /// Quick point-in-polygon check — is this exact point inside an active DMA?
    func checkPointInDMA(latitude: Double, longitude: Double) async throws -> (isInDMA: Bool, name: String?) {
        var components = URLComponents(string: "https://services1.arcgis.com/k8yxvICm95iIFicb/arcgis/rest/services/CWD/FeatureServer/300/query")!
        components.queryItems = [
            URLQueryItem(name: "geometry", value: "\(longitude),\(latitude)"),
            URLQueryItem(name: "geometryType", value: "esriGeometryPoint"),
            URLQueryItem(name: "inSR", value: "4326"),
            URLQueryItem(name: "spatialRel", value: "esriSpatialRelIntersects"),
            URLQueryItem(name: "where", value: "dma_status='A'"),
            URLQueryItem(name: "outFields", value: "dma_name,dma"),
            URLQueryItem(name: "returnGeometry", value: "false"),
            URLQueryItem(name: "f", value: "json")
        ]
        
        guard let url = components.url else { throw DMAPolygonError.invalidURL }
        
        let (data, _) = try await URLSession.shared.data(from: url)
        let response = try JSONDecoder().decode(EsriQueryResponse.self, from: data)
        
        if let feature = response.features?.first {
            return (true, feature.attributes.dma_name)
        }
        return (false, nil)
    }
}

// MARK: - DMAMapView

/// A map view showing the animal location pin and nearby DMA zone overlays.
/// Tells the user visually which DMA zones surround the location and whether
/// the pin itself falls within one.
struct DMAMapView: View {
    let latitude: Double
    let longitude: Double
    
    @State private var zones: [DMAZone] = []
    @State private var isLoading = true
    @State private var pinInDMA: String? = nil // nil = not in DMA, or DMA name
    @State private var errorMessage: String? = nil
    @State private var cameraPosition: MapCameraPosition
    
    init(latitude: Double, longitude: Double) {
        self.latitude = latitude
        self.longitude = longitude
        // Start centered on pin with ~30mi view radius
        _cameraPosition = State(initialValue: .region(MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: latitude, longitude: longitude),
            span: MKCoordinateSpan(latitudeDelta: 0.5, longitudeDelta: 0.5)
        )))
    }
    
    var body: some View {
        ZStack(alignment: .top) {
            // Map with pin + polygon overlays
            Map(position: $cameraPosition) {
                // Animal location pin
                Annotation("Animal Location", coordinate: CLLocationCoordinate2D(latitude: latitude, longitude: longitude)) {
                    ZStack {
                        Circle()
                            .fill(.red)
                            .frame(width: 14, height: 14)
                        Circle()
                            .stroke(.white, lineWidth: 2)
                            .frame(width: 14, height: 14)
                    }
                }
                
                // DMA polygon overlays
                ForEach(zones) { zone in
                    ForEach(0..<zone.coordinates.count, id: \.self) { ringIndex in
                        MapPolygon(coordinates: zone.coordinates[ringIndex])
                            .foregroundStyle(zone.color.opacity(0.2))
                            .stroke(zone.color, lineWidth: 2)
                    }
                }
            }
            .mapStyle(.standard)
            
            // Status banner
            if isLoading {
                bannerView(text: "Checking DMA zones...", color: .gray)
            } else if let error = errorMessage {
                bannerView(text: error, color: .red)
            } else if let dmaName = pinInDMA {
                bannerView(text: "⚠️ This location is within \(dmaName) (Active)", color: .orange)
            } else {
                bannerView(text: "✅ Not within an active Disease Management Area", color: .green)
            }
            
            // Legend (bottom-left)
            if !zones.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("DMA Zones")
                        .font(.caption.bold())
                    ForEach(Array(Set(zones.map(\.name))).sorted(), id: \.self) { name in
                        if let zone = zones.first(where: { $0.name == name }) {
                            HStack(spacing: 6) {
                                RoundedRectangle(cornerRadius: 2)
                                    .fill(zone.color.opacity(0.4))
                                    .overlay(RoundedRectangle(cornerRadius: 2).stroke(zone.color, lineWidth: 1))
                                    .frame(width: 16, height: 12)
                                Text(name)
                                    .font(.caption2)
                            }
                        }
                    }
                }
                .padding(8)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 8))
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                .padding(12)
            }
        }
        .task {
            await loadDMAData()
        }
    }
    
    // MARK: - Helpers
    
    private func bannerView(text: String, color: Color) -> some View {
        Text(text)
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(color.opacity(0.85), in: RoundedRectangle(cornerRadius: 8))
            .padding(.top, 8)
    }
    
    private func loadDMAData() async {
        let service = DMAPolygonService()
        
        do {
            // Fetch polygons and point check in parallel
            async let polygonFetch = service.fetchNearbyDMAs(latitude: latitude, longitude: longitude)
            async let pointCheck = service.checkPointInDMA(latitude: latitude, longitude: longitude)
            
            let (fetchedZones, pointResult) = try await (polygonFetch, pointCheck)
            
            zones = fetchedZones
            pinInDMA = pointResult.isInDMA ? pointResult.name : nil
            isLoading = false
        } catch {
            errorMessage = "Unable to load DMA data"
            isLoading = false
        }
    }
}

// MARK: - Preview

#Preview {
    DMAMapView(latitude: 40.8, longitude: -77.5)
        .frame(height: 500)
}
