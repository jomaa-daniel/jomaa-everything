import SwiftUI

enum AppTheme {
    static let backgroundTop = Color(red: 0.10, green: 0.10, blue: 0.18)
    static let backgroundBottom = Color(red: 0.09, green: 0.13, blue: 0.24)
    static let accent = Color(red: 1.0, green: 0.71, blue: 0.30)
    static let success = Color(red: 0.30, green: 0.69, blue: 0.31)
    static let failure = Color(red: 1.0, green: 0.33, blue: 0.33)
    static let surface = Color.white.opacity(0.08)
    static let border = Color.white.opacity(0.18)
    static let inputPlaceholder = Color.white.opacity(0.65)
}

struct AppBackground: View {
    var body: some View {
        LinearGradient(
            colors: [AppTheme.backgroundTop, AppTheme.backgroundBottom],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
        .ignoresSafeArea()
    }
}

struct SurfaceModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(AppTheme.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(AppTheme.border, lineWidth: 1)
            }
    }
}

extension View {
    func appSurface() -> some View {
        modifier(SurfaceModifier())
    }
}
