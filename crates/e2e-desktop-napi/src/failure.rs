//! What a call answers: its data, or a failure with a code and whether
//! anything reached the app. The JavaScript side translates the code onto
//! the engine's error contract, and reads `delivery` to tell an input that
//! was refused from one that may have landed.

use serde_json::{Value, json};

/// Whether a failed input may have reached the app.
///
/// The line is drawn at the app's content: text typed, a value set, a press,
/// a selection, an item chosen, focus moved into a control, or a list
/// scrolled to bring a control into view. Bringing a
/// window forward, and opening a list's menu that closed again with nothing
/// chosen, change nothing the app keeps, so a failure after only those is
/// still `NotDelivered`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Delivery {
    /// Nothing reached the app's content, so the caller may try another way.
    NotDelivered,
    /// Something was sent, and its effect could not be confirmed.
    Unknown,
}

/// A failure, with a code from the closed list the JavaScript side maps.
#[derive(Debug)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
    pub delivery: Delivery,
    pub details: Option<Value>,
}

impl Failure {
    /// A failure that sent nothing.
    pub fn refused(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), delivery: Delivery::NotDelivered, details: None }
    }

    /// A failure after input may have reached the app.
    pub fn unconfirmed(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into(), delivery: Delivery::Unknown, details: None }
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    /// The same failure, marked as one that may have reached the app.
    pub fn delivered(mut self) -> Self {
        self.delivery = Delivery::Unknown;
        self
    }

    pub fn timeout(what: &str) -> Self {
        Self::refused(codes::TIMEOUT, format!("{what} ran out of time"))
    }
}

/// Every code a failure carries.
pub mod codes {
    pub const STALE_REF: &str = "STALE_REF";
    pub const ELEMENT_NOT_FOUND: &str = "ELEMENT_NOT_FOUND";
    pub const ACTION_NOT_SUPPORTED: &str = "ACTION_NOT_SUPPORTED";
    pub const ACTION_FAILED: &str = "ACTION_FAILED";
    pub const APP_NOT_FOUND: &str = "APP_NOT_FOUND";
    pub const WINDOW_NOT_FOUND: &str = "WINDOW_NOT_FOUND";
    pub const APP_UNRESPONSIVE: &str = "APP_UNRESPONSIVE";
    pub const PERM_DENIED: &str = "PERM_DENIED";
    pub const POLICY_DENIED: &str = "POLICY_DENIED";
    pub const TIMEOUT: &str = "TIMEOUT";
    pub const INVALID_ARGS: &str = "INVALID_ARGS";
    pub const INTERNAL: &str = "INTERNAL";
}

pub type Outcome<T> = Result<T, Failure>;

/// The envelope a call resolves with: `{ ok, data }` or `{ ok, error }`.
pub fn envelope(outcome: Outcome<Value>) -> Value {
    match outcome {
        Ok(data) => json!({ "ok": true, "data": data }),
        Err(failure) => {
            let delivery = match failure.delivery {
                Delivery::NotDelivered => "not_delivered",
                Delivery::Unknown => "delivered_unverified",
            };
            let mut error = json!({
                "code": failure.code,
                "message": failure.message,
                "disposition": { "delivery": delivery },
            });
            if let Some(details) = failure.details {
                error["details"] = details;
            }
            json!({ "ok": false, "error": error })
        }
    }
}
