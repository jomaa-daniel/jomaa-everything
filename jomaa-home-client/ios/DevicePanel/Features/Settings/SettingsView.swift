import DevicePanelCore
import SwiftUI

struct SettingsView: View {
    @ObservedObject var controller: RoomController
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section("Hub") {
                    LabeledContent("Address", value: controller.serverURLString)
                }

                Section("Security") {
                    Label("Session stored in Keychain", systemImage: "lock.shield")
                    Text("Your hub password is used only to sign in and is never saved.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section {
                    Button("Sign Out", role: .destructive) {
                        Task {
                            await controller.signOut()
                            dismiss()
                        }
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}
