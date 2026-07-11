//! WP-INTAKE (ONBOARD) — Power Automate flow-package generator.
//!
//! Onboarding's OneDrive mail transport needs two Power Automate flows in the
//! user's own tenant that write each arriving / sent email as a schema-v1 JSON
//! file into `OneDrive/Apps/Threshold/mail` — the exact files
//! `onedrive_mail_sweep.rs` (SCHEMA v1) parses. This module GENERATES those
//! flows data-driven so onboarding can hand the user a ready artifact.
//!
//! ── Zip vs fallback (the deliberate call) ────────────────────────────────────
//! The ideal is a one-click Power Automate "Import Package (Legacy)" `.zip`. We
//! ship the FALLBACK instead, on purpose:
//!   * No `zip` crate is in the tree, and adding one to a size-conscious signed
//!     desktop app to emit an artifact we CANNOT live-test (there is no Power
//!     Automate import to drive from CI/this Mac) is the wrong trade.
//!   * Microsoft's legacy export schema has undocumented required fields and a
//!     picky import resolver; a package generated blind that fails at import is
//!     strictly worse than a clear, correct recipe (brief §E: "a working
//!     fallback beats a speculative zip that fails at import").
//! So `generate_flow_package` writes, into a chosen directory:
//!   * `threshold-mail-inbox.flow.json`  — the Inbox flow definition
//!   * `threshold-mail-sent.flow.json`   — the Sent flow definition
//!   * `IMPORT-RECIPE.md`                — the paste-ready build steps
//! The UI can one-click-copy any of these. The definitions carry the FROZEN
//! File-Content expression byte-exact, so if the legacy-zip layout is later
//! confirmed the definitions drop straight in.
//!
//! ── The FROZEN contract ──────────────────────────────────────────────────────
//! The `File Content` expression is what `onedrive_mail_sweep` schema v1 parses.
//! It is FROZEN and asserted byte-exact by the unit tests against a literal copy
//! of the brief's spec. Changing it here without changing the parser (and the
//! flow schemaVersion) is a break.

use serde::Serialize;
use serde_json::json;
use std::path::Path;

/// Which mailbox a flow watches. Drives the trigger folder + the `mailbox`
/// literal baked into the frozen expression.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Mailbox {
    Inbox,
    Sent,
}

impl Mailbox {
    /// The `mailbox` value written into each JSON file (`onedrive_mail_sweep`
    /// treats it as informational; both import identically).
    pub fn label(self) -> &'static str {
        match self {
            Mailbox::Inbox => "inbox",
            Mailbox::Sent => "sent",
        }
    }
    /// The Office 365 Outlook trigger's `folderPath`. `Inbox` / `SentItems` are
    /// the well-known folder ids the "When a new email arrives (V3)" trigger
    /// accepts.
    pub fn trigger_folder(self) -> &'static str {
        match self {
            Mailbox::Inbox => "Inbox",
            Mailbox::Sent => "SentItems",
        }
    }
    /// Human flow name (matches the brief's two flows).
    pub fn flow_name(self) -> &'static str {
        match self {
            Mailbox::Inbox => "Threshold mail — Inbox",
            Mailbox::Sent => "Threshold mail — Sent",
        }
    }
    /// Output filename for this flow's definition.
    pub fn definition_filename(self) -> &'static str {
        match self {
            Mailbox::Inbox => "threshold-mail-inbox.flow.json",
            Mailbox::Sent => "threshold-mail-sent.flow.json",
        }
    }
}

/// The OneDrive-for-Business folder the Create-file action targets. Matches
/// `integration_doctor::SWEEP_FOLDER_SEGMENTS` (`Apps/Threshold/mail`).
pub const CREATE_FILE_FOLDER_PATH: &str = "/Apps/Threshold/mail";

/// The Create-file `File Name` expression — a fresh GUID per message so files
/// never collide (the sweep dedups engine-side by internetMessageId anyway).
pub const CREATE_FILE_NAME_EXPRESSION: &str = "@{concat(guid(),'.json')}";

/// The FROZEN `File Content` expression for a mailbox. Produced by templating the
/// `mailbox` literal into the exact createObject shape `onedrive_mail_sweep`
/// schema v1 parses. The unit tests assert this byte-for-byte against a separate
/// literal copy of the brief spec (drift guard).
pub fn file_content_expression(mailbox: Mailbox) -> String {
    format!(
        "string(createObject(\
'schemaVersion',1,\
'mailbox','{m}',\
'from',triggerBody()?['from'],\
'to',coalesce(triggerBody()?['toRecipients'],''),\
'cc',coalesce(triggerBody()?['ccRecipients'],''),\
'subject',coalesce(triggerBody()?['subject'],''),\
'dateTimeCreated',triggerBody()?['receivedDateTime'],\
'bodyHtml',coalesce(triggerBody()?['body'],''),\
'internetMessageId',triggerBody()?['internetMessageId']))",
        m = mailbox.label()
    )
}

/// Build one flow's Logic-App workflow definition (the shape Power Automate's
/// import consumes / the designer round-trips). Data-driven: the two flows differ
/// only in the trigger folder + the frozen expression's `mailbox` literal.
pub fn build_flow_definition(mailbox: Mailbox) -> serde_json::Value {
    let file_content = format!("@{{{}}}", file_content_expression(mailbox));
    json!({
        "name": mailbox.flow_name(),
        "properties": {
            "displayName": mailbox.flow_name(),
            "definition": {
                "$schema": "https://schema.management.azure.com/providers/Microsoft.Logic/schemas/2016-06-01/workflowdefinition.json#",
                "contentVersion": "1.0.0.0",
                "parameters": {
                    "$connections": { "defaultValue": {}, "type": "Object" },
                    "$authentication": { "defaultValue": {}, "type": "SecureObject" }
                },
                "triggers": {
                    "When_a_new_email_arrives_V3": {
                        "type": "OpenApiConnectionNotification",
                        "splitOn": "@triggerOutputs()?['body/value']",
                        "inputs": {
                            "host": {
                                "connectionName": "shared_office365",
                                "operationId": "OnNewEmailV3",
                                "apiId": "/providers/Microsoft.PowerApps/apis/shared_office365"
                            },
                            "parameters": {
                                "folderPath": mailbox.trigger_folder(),
                                "importance": "Any",
                                "fetchOnlyWithAttachment": false,
                                "includeAttachments": false
                            },
                            "authentication": "@parameters('$authentication')"
                        }
                    }
                },
                "actions": {
                    "Create_file": {
                        "type": "OpenApiConnection",
                        "runAfter": {},
                        "inputs": {
                            "host": {
                                "connectionName": "shared_onedriveforbusiness",
                                "operationId": "CreateFile",
                                "apiId": "/providers/Microsoft.PowerApps/apis/shared_onedriveforbusiness"
                            },
                            "parameters": {
                                "folderPath": CREATE_FILE_FOLDER_PATH,
                                "name": CREATE_FILE_NAME_EXPRESSION,
                                "body": file_content
                            },
                            "authentication": "@parameters('$authentication')"
                        }
                    }
                }
            }
        },
        "connectionReferences": {
            "shared_office365": {
                "runtimeSource": "embedded",
                "connection": {},
                "api": { "name": "shared_office365" }
            },
            "shared_onedriveforbusiness": {
                "runtimeSource": "embedded",
                "connection": {},
                "api": { "name": "shared_onedriveforbusiness" }
            }
        }
    })
}

/// The paste-ready recipe. Documents the 5-step manual build (the fallback for
/// the one-click package) with the frozen expressions inline so a user can
/// one-click-copy each into the Power Automate designer. Deterministic — the
/// unit test asserts the frozen expressions appear verbatim.
pub fn build_recipe() -> String {
    let inbox_expr = file_content_expression(Mailbox::Inbox);
    let sent_expr = file_content_expression(Mailbox::Sent);
    format!(
        r#"# Threshold mail flows — 1-minute setup

These two Power Automate flows quietly copy each email into
`OneDrive → Apps → Threshold → mail` as a small JSON file. Threshold's app sweeps
that folder and pulls each message into your workspace — no forwarding, no BCC.

You build them once, in your own Microsoft account. Nothing here needs admin
rights (standard Office 365 Outlook + OneDrive for Business connectors).

> Prefer to import? These same two flows are provided as
> `threshold-mail-inbox.flow.json` and `threshold-mail-sent.flow.json` next to
> this file — the definitions are exact, but manual build below is the reliable
> path and takes about a minute.

## Do this twice — once for **Inbox**, once for **Sent**

**Step 1 — New flow.** Go to Power Automate → **Create** → **Automated cloud
flow**. Name it `{inbox_name}` (or `{sent_name}` for the second).

**Step 2 — Trigger.** Choose **Office 365 Outlook → When a new email arrives
(V3)**. Set **Folder** to **Inbox** (for the Sent flow, set it to **Sent Items**).
Leave the other options at their defaults.

**Step 3 — Action.** Add **OneDrive for Business → Create file**.
- **Folder Path:** `{folder}`
- **File Name:** switch the field to expression and paste:

    concat(guid(),'.json')

**Step 4 — File Content (the important one).** In the **File Content** field,
switch to the expression editor and paste EXACTLY this for the **Inbox** flow:

    {inbox_expr}

…and this for the **Sent** flow:

    {sent_expr}

**Step 5 — Save + test.** Save the flow. Send yourself a test email; within a
minute a `.json` file appears in `OneDrive/Apps/Threshold/mail`. Threshold's
channel flips green on its next sweep. That's the whole 5-step import test.

---

If a step is blocked ("your admin hasn't allowed this connector"), that's an
org policy — Threshold's doctor records it and falls back to the classic-Outlook
or add-in path. Nothing here ever exposes more than the emails you already
receive.
"#,
        inbox_name = Mailbox::Inbox.flow_name(),
        sent_name = Mailbox::Sent.flow_name(),
        folder = CREATE_FILE_FOLDER_PATH,
        inbox_expr = inbox_expr,
        sent_expr = sent_expr,
    )
}

/// The files `generate_flow_package` wrote, returned to the UI so it can reveal /
/// copy them.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedPackage {
    /// The directory everything was written into.
    pub dir: String,
    /// Absolute path to the Inbox flow definition.
    pub inbox_definition: String,
    /// Absolute path to the Sent flow definition.
    pub sent_definition: String,
    /// Absolute path to the recipe markdown.
    pub recipe: String,
    /// True — signals the UI this is the definition+recipe fallback, not a
    /// one-click `.zip` package (so it renders the "build in ~1 min" guidance,
    /// not "import this zip").
    pub is_fallback: bool,
}

/// Write the two flow definitions + the recipe into `dest_dir`, creating a
/// `Threshold-PowerAutomate/` subfolder so the artifacts stay grouped (e.g. in
/// Downloads). Overwrites on re-run (idempotent). Returns the written paths.
pub fn generate_flow_package(dest_dir: &Path) -> std::io::Result<GeneratedPackage> {
    let pkg_dir = dest_dir.join("Threshold-PowerAutomate");
    std::fs::create_dir_all(&pkg_dir)?;

    let inbox_path = pkg_dir.join(Mailbox::Inbox.definition_filename());
    let sent_path = pkg_dir.join(Mailbox::Sent.definition_filename());
    let recipe_path = pkg_dir.join("IMPORT-RECIPE.md");

    let inbox_json = serde_json::to_string_pretty(&build_flow_definition(Mailbox::Inbox))
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    let sent_json = serde_json::to_string_pretty(&build_flow_definition(Mailbox::Sent))
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;

    std::fs::write(&inbox_path, inbox_json)?;
    std::fs::write(&sent_path, sent_json)?;
    std::fs::write(&recipe_path, build_recipe())?;

    Ok(GeneratedPackage {
        dir: pkg_dir.to_string_lossy().into_owned(),
        inbox_definition: path_string(&inbox_path),
        sent_definition: path_string(&sent_path),
        recipe: path_string(&recipe_path),
        is_fallback: true,
    })
}

fn path_string(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit tests — the FROZEN-expression drift guard + definition/package shape.
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    // The canonical frozen strings, copied verbatim from the ONBOARD brief spec.
    // If `file_content_expression` ever drifts from what `onedrive_mail_sweep`
    // schema v1 parses, THIS is the test that fails.
    const FROZEN_INBOX: &str = "string(createObject('schemaVersion',1,'mailbox','inbox','from',triggerBody()?['from'],'to',coalesce(triggerBody()?['toRecipients'],''),'cc',coalesce(triggerBody()?['ccRecipients'],''),'subject',coalesce(triggerBody()?['subject'],''),'dateTimeCreated',triggerBody()?['receivedDateTime'],'bodyHtml',coalesce(triggerBody()?['body'],''),'internetMessageId',triggerBody()?['internetMessageId']))";
    const FROZEN_SENT: &str = "string(createObject('schemaVersion',1,'mailbox','sent','from',triggerBody()?['from'],'to',coalesce(triggerBody()?['toRecipients'],''),'cc',coalesce(triggerBody()?['ccRecipients'],''),'subject',coalesce(triggerBody()?['subject'],''),'dateTimeCreated',triggerBody()?['receivedDateTime'],'bodyHtml',coalesce(triggerBody()?['body'],''),'internetMessageId',triggerBody()?['internetMessageId']))";

    #[test]
    fn file_content_expression_is_frozen_byte_exact() {
        assert_eq!(file_content_expression(Mailbox::Inbox), FROZEN_INBOX);
        assert_eq!(file_content_expression(Mailbox::Sent), FROZEN_SENT);
        // The only difference between them is the mailbox literal.
        assert_eq!(
            FROZEN_INBOX.replace("'mailbox','inbox'", "'mailbox','sent'"),
            FROZEN_SENT
        );
    }

    #[test]
    fn frozen_expression_keys_match_schema_v1_fields() {
        // The keys the sweep's MailFileV1 reads (bodyText/inReplyTo/references are
        // optional and intentionally omitted — the trigger doesn't expose them;
        // bodyHtml present ⇒ the parser's at-least-one-body floor is met).
        for key in [
            "'schemaVersion'",
            "'mailbox'",
            "'from'",
            "'to'",
            "'cc'",
            "'subject'",
            "'dateTimeCreated'",
            "'bodyHtml'",
            "'internetMessageId'",
        ] {
            assert!(
                FROZEN_INBOX.contains(key),
                "frozen expression must carry {key}"
            );
        }
    }

    #[test]
    fn flow_definition_parses_and_carries_frozen_expression() {
        for (mb, frozen, folder) in [
            (Mailbox::Inbox, FROZEN_INBOX, "Inbox"),
            (Mailbox::Sent, FROZEN_SENT, "SentItems"),
        ] {
            let def = build_flow_definition(mb);
            // Round-trips through JSON.
            let s = serde_json::to_string(&def).unwrap();
            let reparsed: serde_json::Value = serde_json::from_str(&s).unwrap();
            assert_eq!(reparsed, def);

            let props = &def["properties"];
            let actions = &props["definition"]["actions"]["Create_file"]["inputs"]["parameters"];
            // Create-file targets the sweep folder + guid filename.
            assert_eq!(actions["folderPath"], CREATE_FILE_FOLDER_PATH);
            assert_eq!(actions["name"], CREATE_FILE_NAME_EXPRESSION);
            // File Content carries the frozen expression, wrapped @{...}.
            assert_eq!(actions["body"], format!("@{{{}}}", frozen));

            // Trigger watches the right folder.
            let trig = &props["definition"]["triggers"]["When_a_new_email_arrives_V3"]
                ["inputs"]["parameters"]["folderPath"];
            assert_eq!(trig, folder);

            // Both connectors are referenced.
            assert!(def["connectionReferences"].get("shared_office365").is_some());
            assert!(def["connectionReferences"]
                .get("shared_onedriveforbusiness")
                .is_some());
        }
    }

    #[test]
    fn recipe_contains_both_frozen_expressions_and_folder() {
        let r = build_recipe();
        assert!(r.contains(FROZEN_INBOX));
        assert!(r.contains(FROZEN_SENT));
        assert!(r.contains(CREATE_FILE_FOLDER_PATH));
        assert!(r.contains("concat(guid(),'.json')"));
        // Names both flows.
        assert!(r.contains(Mailbox::Inbox.flow_name()));
        assert!(r.contains(Mailbox::Sent.flow_name()));
    }

    /// Eyeball smoke — writes a real package to a chosen dir + prints paths.
    /// `#[ignore]` (writes outside tempdir on demand):
    ///   `cargo test --lib flow_package_live_smoke -- --ignored --nocapture`
    /// Set `FLOWPKG_OUT` to the target directory.
    #[test]
    #[ignore]
    fn flow_package_live_smoke() {
        let out = std::env::var("FLOWPKG_OUT").expect("set FLOWPKG_OUT");
        let pkg = generate_flow_package(Path::new(&out)).unwrap();
        println!("FLOWPKG={}", serde_json::to_string_pretty(&pkg).unwrap());
    }

    #[test]
    fn generate_flow_package_writes_all_three_files() {
        let root = std::env::temp_dir().join(format!(
            "threshold-flowpkg-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();

        let pkg = generate_flow_package(&root).unwrap();
        assert!(pkg.is_fallback);

        // All three exist under the grouped subfolder.
        assert!(Path::new(&pkg.inbox_definition).exists());
        assert!(Path::new(&pkg.sent_definition).exists());
        assert!(Path::new(&pkg.recipe).exists());
        assert!(pkg.dir.ends_with("Threshold-PowerAutomate"));

        // The written definitions parse + carry the frozen expression.
        let inbox: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&pkg.inbox_definition).unwrap()).unwrap();
        let body = &inbox["properties"]["definition"]["actions"]["Create_file"]["inputs"]
            ["parameters"]["body"];
        assert_eq!(body, &format!("@{{{}}}", FROZEN_INBOX));

        // Idempotent — a second run overwrites cleanly.
        let pkg2 = generate_flow_package(&root).unwrap();
        assert_eq!(pkg.inbox_definition, pkg2.inbox_definition);

        let _ = std::fs::remove_dir_all(&root);
    }
}
