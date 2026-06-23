//
//  DMALookup.swift
//
//  Self-contained helper for querying the Pennsylvania Game Commission (PGC)
//  ArcGIS REST API to determine whether a GPS coordinate falls inside a
//  Chronic Wasting Disease (CWD) Disease Management Area (DMA).
//
//  Drop this single file into your iOS project (iOS 16+). It provides:
//    1. `DMAService`    — an async networking service that performs the lookup.
//    2. `DMAResult`     — the result type returned by the lookup.
//    3. `DMACheckView`  — a SwiftUI demo view showing loading / result states.
//
//  ----------------------------------------------------------------------------
//  ABOUT THE API
//  ----------------------------------------------------------------------------
//  This is a PUBLIC PGC ArcGIS endpoint. No API key, token, or auth is required.
//
//  Endpoint (PGC hosted FeatureServer, CWD service, layer 300):
//    https://services1.arcgis.com/k8yxvICm95iIFicb/arcgis/rest/services/CWD/FeatureServer/300/query
//
//  We perform a point-in-polygon spatial query with these parameters:
//    geometry=LONGITUDE,LATITUDE   <-- x,y order: LONGITUDE FIRST, then LATITUDE.
//                                      This is the single most common mistake.
//                                      It is NOT lat,lon.
//    geometryType=esriGeometryPoint
//    inSR=4326                     <-- WGS84 (standard GPS lat/lon).
//    spatialRel=esriSpatialRelIntersects
//    where=dma_status='A'          <-- ACTIVE DMAs only (see status codes below).
//    outFields=dma_name,dma,dma_status,start_date,end_date,area_sqmi
//    returnGeometry=false
//    f=json
//
//  NOTE: This FeatureServer uses LOWERCASE field names (`dma_name`, `dma`),
//  unlike the older MapServer/28 layer which used uppercase (`NAME`, `DMA`).
//
//  Field reference:
//    dma_name    String  Human-readable name, e.g. "DMA 2".
//    dma         Int     DMA number, e.g. 2.
//    dma_status  String  Coded status: "A" = Active, "I" = Inactive, "P" = Proposed.
//    start_date  Number  Effective start date, epoch MILLISECONDS (may be null).
//    end_date    Number  Effective end date, epoch MILLISECONDS (may be null).
//    area_sqmi   Number  Area of the DMA polygon in square miles (may be null).
//
//  A successful response has a `features` array. Each matching DMA polygon is
//  one feature with an `attributes` object:
//
//    { "features": [ { "attributes": {
//        "dma_name": "DMA 2", "dma": 2, "dma_status": "A",
//        "start_date": 1377993600000, "end_date": null, "area_sqmi": 4123.5
//    } } ] }
//
//  Because we filter with `where=dma_status='A'`, only ACTIVE DMAs are returned.
//
//  An EMPTY features array (`"features": []`) means the coordinate is NOT inside
//  any active DMA. Treat that as "no DMA here", not as an error.
//
//  ----------------------------------------------------------------------------
//  HOW TO INTEGRATE
//  ----------------------------------------------------------------------------
//    let service = DMAService()
//    let result = try await service.checkDMA(latitude: 40.8, longitude: -77.5)
//    if result.isInDMA {
//        print("Inside \(result.name ?? "a DMA")")  // e.g. "Inside DMA 2"
//    }
//
//  Or simply preview/use `DMACheckView(latitude:longitude:)` directly.
//

import Foundation
import SwiftUI

// MARK: - Result Type

/// The outcome of a DMA lookup for a single coordinate.
public struct DMAResult: Equatable, Sendable {
    /// `true` if the coordinate falls inside an active Disease Management Area.
    public let isInDMA: Bool

    /// Human-readable DMA name, e.g. `"DMA 2"`. `nil` if not in a DMA.
    public let name: String?

    /// DMA number, e.g. `2`. `nil` if not in a DMA.
    public let number: Int?

    /// Raw DMA status code: `"A"` (Active), `"I"` (Inactive), `"P"` (Proposed).
    /// `nil` if not in a DMA. (Lookups filter for `"A"`, so this is normally `"A"`.)
    public let status: String?

    /// Effective start date of the DMA. `nil` if the service did not supply one.
    public let startDate: Date?

    /// Effective end date of the DMA. `nil` if the service did not supply one.
    public let endDate: Date?

    /// Area of the DMA polygon in square miles. `nil` if not supplied.
    public let areaSquareMiles: Double?

    public init(
        isInDMA: Bool,
        name: String?,
        number: Int?,
        status: String? = nil,
        startDate: Date? = nil,
        endDate: Date? = nil,
        areaSquareMiles: Double? = nil
    ) {
        self.isInDMA = isInDMA
        self.name = name
        self.number = number
        self.status = status
        self.startDate = startDate
        self.endDate = endDate
        self.areaSquareMiles = areaSquareMiles
    }

    /// Convenience value representing "not inside any DMA".
    public static let notInDMA = DMAResult(
        isInDMA: false,
        name: nil,
        number: nil,
        status: nil,
        startDate: nil,
        endDate: nil,
        areaSquareMiles: nil
    )
}

// MARK: - Errors

/// Errors that can occur while performing a DMA lookup.
public enum DMAError: LocalizedError {
    case invalidCoordinate
    case invalidURL
    case badResponse(statusCode: Int)
    case decodingFailed(underlying: Error)
    /// The ArcGIS service returned an error object instead of features.
    case serviceError(message: String)

    public var errorDescription: String? {
        switch self {
        case .invalidCoordinate:
            return "The latitude/longitude provided is out of range."
        case .invalidURL:
            return "Failed to build a valid request URL."
        case .badResponse(let code):
            return "The DMA service returned an unexpected status code (\(code))."
        case .decodingFailed(let underlying):
            return "Failed to decode the DMA service response: \(underlying.localizedDescription)"
        case .serviceError(let message):
            return "The DMA service reported an error: \(message)"
        }
    }
}

// MARK: - Codable Response Models
//
// These mirror the Esri ArcGIS JSON response. We only decode the fields we need.

/// Top-level response from the ArcGIS `/query` endpoint.
private struct ArcGISQueryResponse: Decodable {
    let features: [ArcGISFeature]?
    let error: ArcGISServiceError?
}

/// A single matching DMA polygon feature.
private struct ArcGISFeature: Decodable {
    let attributes: ArcGISAttributes
}

/// The requested attribute fields for a feature.
///
/// The FeatureServer/300 layer uses LOWERCASE field names.
private struct ArcGISAttributes: Decodable {
    let name: String?
    let dma: Int?
    let status: String?
    /// Epoch milliseconds as returned by ArcGIS (may be `null`).
    let startDateMillis: Double?
    /// Epoch milliseconds as returned by ArcGIS (may be `null`).
    let endDateMillis: Double?
    let areaSquareMiles: Double?

    enum CodingKeys: String, CodingKey {
        case name = "dma_name"
        case dma = "dma"
        case status = "dma_status"
        case startDateMillis = "start_date"
        case endDateMillis = "end_date"
        case areaSquareMiles = "area_sqmi"
    }
}

/// Error object the service may return instead of `features`.
private struct ArcGISServiceError: Decodable {
    let code: Int?
    let message: String?
}

// MARK: - Service

/// Queries the PGC ArcGIS REST API to determine whether a coordinate is inside
/// an active CWD Disease Management Area.
///
/// This type is `Sendable` and safe to use from any async context.
public struct DMAService: Sendable {

    /// Base URL of the PGC DMA point-in-polygon query endpoint
    /// (CWD FeatureServer, layer 300).
    private static let endpoint =
        "https://services1.arcgis.com/k8yxvICm95iIFicb/arcgis/rest/services/CWD/FeatureServer/300/query"

    private let session: URLSession

    /// - Parameter session: Inject a custom `URLSession` for testing. Defaults
    ///   to `.shared`.
    public init(session: URLSession = .shared) {
        self.session = session
    }

    /// Determines whether the given coordinate falls inside an active CWD
    /// Disease Management Area.
    ///
    /// - Parameters:
    ///   - latitude:  Latitude in WGS84 (e.g. `40.8`).
    ///   - longitude: Longitude in WGS84 (e.g. `-77.5`).
    /// - Returns: A `DMAResult` describing the DMA (if any).
    /// - Throws: `DMAError` on invalid input, networking, or decoding failure.
    public func checkDMA(latitude: Double, longitude: Double) async throws -> DMAResult {
        // Basic sanity check on the coordinate range.
        guard (-90.0...90.0).contains(latitude),
              (-180.0...180.0).contains(longitude) else {
            throw DMAError.invalidCoordinate
        }

        let url = try makeURL(latitude: latitude, longitude: longitude)

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(from: url)
        } catch {
            // Surface raw networking errors (no connection, timeout, etc.).
            throw error
        }

        if let http = response as? HTTPURLResponse,
           !(200...299).contains(http.statusCode) {
            throw DMAError.badResponse(statusCode: http.statusCode)
        }

        let decoded: ArcGISQueryResponse
        do {
            decoded = try JSONDecoder().decode(ArcGISQueryResponse.self, from: data)
        } catch {
            throw DMAError.decodingFailed(underlying: error)
        }

        // The service may return an error object instead of features.
        if let serviceError = decoded.error {
            throw DMAError.serviceError(
                message: serviceError.message ?? "Unknown service error."
            )
        }

        // An empty (or missing) features array means "not in any active DMA".
        guard let firstMatch = decoded.features?.first else {
            return .notInDMA
        }

        let attributes = firstMatch.attributes
        return DMAResult(
            isInDMA: true,
            name: attributes.name,
            number: attributes.dma,
            status: attributes.status,
            startDate: Self.date(fromEpochMillis: attributes.startDateMillis),
            endDate: Self.date(fromEpochMillis: attributes.endDateMillis),
            areaSquareMiles: attributes.areaSquareMiles
        )
    }

    /// Converts ArcGIS epoch-millisecond timestamps into a `Date`.
    private static func date(fromEpochMillis millis: Double?) -> Date? {
        guard let millis else { return nil }
        return Date(timeIntervalSince1970: millis / 1000.0)
    }

    /// Builds the fully-formed query URL.
    ///
    /// IMPORTANT: `geometry` is `x,y` = `longitude,latitude` — longitude first.
    private func makeURL(latitude: Double, longitude: Double) throws -> URL {
        guard var components = URLComponents(string: Self.endpoint) else {
            throw DMAError.invalidURL
        }

        components.queryItems = [
            // x,y order: LONGITUDE first, LATITUDE second.
            URLQueryItem(name: "geometry", value: "\(longitude),\(latitude)"),
            URLQueryItem(name: "geometryType", value: "esriGeometryPoint"),
            URLQueryItem(name: "inSR", value: "4326"),
            URLQueryItem(name: "spatialRel", value: "esriSpatialRelIntersects"),
            // Active DMAs only.
            URLQueryItem(name: "where", value: "dma_status='A'"),
            URLQueryItem(
                name: "outFields",
                value: "dma_name,dma,dma_status,start_date,end_date,area_sqmi"
            ),
            URLQueryItem(name: "returnGeometry", value: "false"),
            URLQueryItem(name: "f", value: "json"),
        ]

        guard let url = components.url else {
            throw DMAError.invalidURL
        }
        return url
    }
}

// MARK: - SwiftUI Demo View

/// A simple demo view that looks up a coordinate and renders the DMA result.
///
/// Loading -> shows a spinner.
/// In a DMA -> amber warning card.
/// Not in a DMA -> green "clear" card.
/// Error -> red error card with a retry button.
public struct DMACheckView: View {

    /// Internal view state machine.
    private enum LoadState: Equatable {
        case idle
        case loading
        case loaded(DMAResult)
        case failed(String)
    }

    private let latitude: Double
    private let longitude: Double
    private let service: DMAService

    @State private var state: LoadState = .idle

    public init(
        latitude: Double,
        longitude: Double,
        service: DMAService = DMAService()
    ) {
        self.latitude = latitude
        self.longitude = longitude
        self.service = service
    }

    public var body: some View {
        VStack(spacing: 16) {
            Text("CWD Disease Management Area Check")
                .font(.headline)
                .multilineTextAlignment(.center)

            Text(String(format: "%.5f, %.5f", latitude, longitude))
                .font(.subheadline.monospaced())
                .foregroundStyle(.secondary)

            content
                .frame(maxWidth: .infinity)
                .animation(.default, value: state)
        }
        .padding()
        .task {
            // Kick off the lookup automatically when the view appears.
            if case .idle = state {
                await runCheck()
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch state {
        case .idle, .loading:
            loadingCard
        case .loaded(let result):
            resultCard(for: result)
        case .failed(let message):
            errorCard(message: message)
        }
    }

    // MARK: Subviews

    private var loadingCard: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text("Checking Disease Management Areas…")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding()
        .frame(maxWidth: .infinity)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
    }

    @ViewBuilder
    private func resultCard(for result: DMAResult) -> some View {
        if result.isInDMA {
            // Amber warning: the location IS inside a DMA.
            card(
                systemImage: "exclamationmark.triangle.fill",
                title: result.name ?? "Disease Management Area",
                subtitle: dmaSubtitle(for: result),
                tint: .orange
            )
        } else {
            // Green / clear: location is NOT inside any DMA.
            card(
                systemImage: "checkmark.seal.fill",
                title: "Not in a DMA",
                subtitle: "This location is not within any Disease Management Area.",
                tint: .green
            )
        }
    }

    private func errorCard(message: String) -> some View {
        VStack(spacing: 12) {
            card(
                systemImage: "wifi.exclamationmark",
                title: "Lookup Failed",
                subtitle: message,
                tint: .red
            )
            Button("Retry") {
                Task { await runCheck() }
            }
            .buttonStyle(.borderedProminent)
        }
    }

    /// Reusable styled status card.
    private func card(
        systemImage: String,
        title: String,
        subtitle: String,
        tint: Color
    ) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage)
                .font(.title2)
                .foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(tint)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding()
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(tint.opacity(0.4), lineWidth: 1)
        )
    }

    private func dmaSubtitle(for result: DMAResult) -> String {
        var parts = ["This location is within an active CWD Disease Management Area."]
        if let number = result.number {
            parts.append("DMA number: \(number).")
        }
        if let area = result.areaSquareMiles {
            parts.append(String(format: "Area: %.0f sq mi.", area))
        }
        if let start = result.startDate {
            let formatter = DateFormatter()
            formatter.dateStyle = .medium
            formatter.timeStyle = .none
            parts.append("In effect since \(formatter.string(from: start)).")
        }
        parts.append("Special carcass/parts handling rules may apply.")
        return parts.joined(separator: " ")
    }

    // MARK: Actions

    private func runCheck() async {
        state = .loading
        do {
            let result = try await service.checkDMA(
                latitude: latitude,
                longitude: longitude
            )
            state = .loaded(result)
        } catch {
            let message = (error as? LocalizedError)?.errorDescription
                ?? error.localizedDescription
            state = .failed(message)
        }
    }
}

// MARK: - Preview

#if DEBUG
#Preview("In DMA 2") {
    // -77.5, 40.8 falls inside DMA 2 per the PGC service.
    DMACheckView(latitude: 40.8, longitude: -77.5)
}
#endif
