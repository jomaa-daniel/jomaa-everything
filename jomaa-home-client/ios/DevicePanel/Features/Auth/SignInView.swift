import DevicePanelCore
import SwiftUI
import UIKit

struct SignInView: View {
    @ObservedObject var controller: RoomController
    @State private var password = ""
    @FocusState private var passwordFocused: Bool

    var body: some View {
        NavigationStack {
            ZStack {
                AppBackground()

                ScrollView {
                    VStack(spacing: 24) {
                        Image(systemName: "lightbulb.max.fill")
                            .font(.system(size: 54, weight: .medium))
                            .foregroundStyle(AppTheme.accent)
                            .accessibilityHidden(true)

                        VStack(spacing: 8) {
                            Text("Device Panel")
                                .font(.largeTitle.bold())
                            Text("Control your home's lights through your hub.")
                                .font(.body)
                                .foregroundStyle(.secondary)
                                .multilineTextAlignment(.center)
                        }

                        VStack(spacing: 16) {
                            SecureField(
                                "Hub password",
                                text: $password,
                                prompt: Text("Hub password").foregroundStyle(AppTheme.inputPlaceholder)
                            )
                                .textContentType(.password)
                                .submitLabel(.go)
                                .focused($passwordFocused)
                                .onSubmit(signIn)
                                .accessibilityIdentifier("passwordField")

                            if let error = controller.lastError {
                                Label(error, systemImage: "exclamationmark.triangle.fill")
                                    .font(.footnote)
                                    .foregroundStyle(AppTheme.failure)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .accessibilityLabel("Sign-in error: \(error)")
                            }

                            Button(action: signIn) {
                                HStack {
                                    if controller.authentication == .signingIn {
                                        ProgressView()
                                            .tint(AppTheme.backgroundTop)
                                    }
                                    Text(controller.authentication == .signingIn ? "Signing In…" : "Sign In")
                                        .fontWeight(.semibold)
                                }
                                .frame(maxWidth: .infinity, minHeight: 48)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(AppTheme.accent)
                            .foregroundStyle(AppTheme.backgroundTop)
                            .disabled(!canSubmit || controller.authentication == .signingIn)
                            .accessibilityIdentifier("signInButton")
                        }
                        .textFieldStyle(.roundedBorder)
                        .padding(20)
                        .appSurface()
                    }
                    .frame(maxWidth: 480)
                    .padding(.horizontal, 24)
                    .padding(.vertical, 48)
                    .frame(maxWidth: .infinity)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .onAppear {
                passwordFocused = true
            }
        }
    }

    private var canSubmit: Bool {
        !password.isEmpty
    }

    private func signIn() {
        guard canSubmit else { return }
        passwordFocused = false
        Task {
            await controller.signIn(password: password)
            password = ""
        }
    }
}
