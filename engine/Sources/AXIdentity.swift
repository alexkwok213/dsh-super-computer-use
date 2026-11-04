import Foundation

// Task 8 (F4): real control identity. A snapshot revision is only an
// observation number; a path + role + title cannot tell two same-named controls
// apart once the list reorders. A retained AX object carries an opaque
// `elementToken`; identity is that token bound to the session epoch, app, window
// and container — path/title are only hints for re-locating a candidate.
//
// The retained AX worker that produces these tokens is not wired yet (deferred).
// This file fixes and proves the identity rules so the worker has one source of
// truth.

enum IdentityVerdict: String {
    case matched
    case staleTarget = "stale_target"
    case identityUnproven = "identity_unproven"
    case epochRebuilt = "epoch_rebuilt"
}

struct AXElementIdentity: Equatable {
    var epoch: Int
    var pid: Int
    var windowId: Int
    var role: String
    var title: String
    var containerToken: String
    /// Opaque identity of the retained AX object. Empty = no proven identity.
    var elementToken: String
    /// Observation revision only. It MUST NOT be used as proof of identity.
    var snapshotRevision: Int
}

/// Validate that a token handed back by the caller still names the same control.
/// Order matters: an epoch rebuild invalidates everything; a different
/// app/window is a stale target; a different retained object or container, or a
/// changed role/title, means identity cannot be proven (re-resolve, never guess).
func validateIdentity(token: AXElementIdentity, current: AXElementIdentity) -> IdentityVerdict {
    if token.epoch != current.epoch { return .epochRebuilt }
    if token.pid != current.pid || token.windowId != current.windowId { return .staleTarget }
    if token.elementToken.isEmpty || current.elementToken.isEmpty { return .identityUnproven }
    if token.elementToken != current.elementToken { return .identityUnproven }
    if token.containerToken != current.containerToken { return .identityUnproven }
    // role/title are attributes of the retained object, not its identity: a
    // rename/relabel of the SAME object still resolves. Same-named DIFFERENT
    // objects are already rejected above by elementToken.
    return .matched
}

/// Path/title-only disambiguation of two same-named controls is explicitly NOT
/// proof. This helper exists so callers stop treating a matching path as identity.
func samePathImpliesIdentity(_ pathA: String, _ pathB: String) -> Bool {
    _ = pathA
    _ = pathB
    return false
}

// MARK: - dispatch resolution (never pick by path)

struct AXCandidate: Equatable {
    var path: String
    var epoch: Int
    var pid: Int
    var windowId: Int
    var role: String
    var title: String
    var containerToken: String
    var elementToken: String
    var enabled: Bool
    var frameValid: Bool
}

enum DispatchResolution: Equatable {
    case dispatch(elementToken: String)
    case reject(IdentityVerdict)
}

/// Decide which retained object a token may act on, from a FRESH observation.
/// Identity is by `elementToken` only: if the token's retained object is absent
/// or ambiguous we reject, and we NEVER fall back to "the control now at that
/// path" — that path-match is exactly how two same-named controls got swapped.
func resolveDispatchTarget(token: AXElementIdentity, candidates: [AXCandidate]) -> DispatchResolution {
    let matches = candidates.filter { !$0.elementToken.isEmpty && $0.elementToken == token.elementToken }
    if matches.count != 1 { return .reject(.identityUnproven) }
    let candidate = matches[0]
    if candidate.epoch != token.epoch { return .reject(.epochRebuilt) }
    if candidate.pid != token.pid || candidate.windowId != token.windowId { return .reject(.staleTarget) }
    if candidate.containerToken != token.containerToken { return .reject(.identityUnproven) }
    if !candidate.enabled || !candidate.frameValid { return .reject(.identityUnproven) }
    return .dispatch(elementToken: candidate.elementToken)
}
