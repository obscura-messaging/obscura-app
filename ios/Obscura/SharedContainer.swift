import Foundation

/// App Group resources reserved for a possible future extension.
///
/// The current background APNs payload does not launch an extension. If that
/// transport changes, the extension will need the SQLCipher database, its key,
/// and the session used to obtain a gateway ticket.
enum SharedContainer {

    /// The App Group identifier. Must match the entitlement in `Obscura.entitlements` **and** a
    /// group registered against the team in the Apple Developer portal — an unregistered group
    /// silently yields a `nil` container rather than a build error, which is what `isAvailable`
    /// below is for.
    static let appGroupId = "group.\(Bundle.main.bundleIdentifier ?? "dev.barrelmaker.obscura.dev")"

    /// The shared container, or `nil` when the entitlement is absent or unprovisioned.
    static var containerURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroupId)
    }

    /// Whether the App Group is actually usable in this build.
    ///
    /// This is a *runtime* question, not a compile-time one: the entitlement can be present in the
    /// file and still not provisioned by the profile the app was signed with. Everything below
    /// falls back to app-private storage when this is `false`.
    static var isAvailable: Bool { containerURL != nil }

    /// The keychain access group a future extension would read.
    ///
    /// On iOS an App Group identifier is itself a valid keychain access group when the app carries
    /// the app-groups entitlement, so no team-id prefix is hardcoded here. If a build ever fails to
    /// find its items with this set, the alternative is a `keychain-access-groups` entitlement
    /// holding `$(AppIdentifierPrefix)dev.barrelmaker.obscura.shared` and that literal string here — note
    /// that adding that entitlement also makes its **first** entry the default access group for
    /// items that do not name one, so the app's own identifier must be listed first or existing
    /// items move out from under the code that wrote them.
    ///
    /// `nil` when the group is unavailable, which is exactly what both the kit and `KeychainSession`
    /// treat as "use the default group".
    static var keychainAccessGroup: String? { isAvailable ? appGroupId : nil }

    /// Log once at startup so a silently-unprovisioned group is visible.
    static func logStatus(_ log: (String) -> Void) {
        if let containerURL {
            log("[SharedContainer] App Group \(appGroupId) available at \(containerURL.path)")
        } else {
            log("[SharedContainer] App Group \(appGroupId) UNAVAILABLE — falling back to the "
                + "app-private container and the default keychain group. The app can run, but a "
                + "future Notification Service Extension will not be able "
                + "to read this device's database or session. Check the entitlement and that the "
                + "group is registered in the Apple Developer portal.")
        }
    }
}
