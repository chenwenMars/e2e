//! The accessibility API: an owned `AXUIElementRef`, typed attribute reads
//! and writes, and the AX error codes. Every call here is a synchronous
//! request to the app's process, bounded by the messaging timeout.

use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_foundation_sys::array::{CFArrayGetCount, CFArrayGetValueAtIndex, CFArrayRef};
use core_foundation_sys::base::{Boolean, CFEqual, CFGetTypeID, CFHash, CFIndex, CFRange, CFRelease, CFRetain, CFTypeID, CFTypeRef};
use core_foundation_sys::string::{CFStringGetTypeID, CFStringRef};
use std::ffi::c_void;
use std::hash::{Hash, Hasher};

pub type AXError = i32;
pub const AX_SUCCESS: AXError = 0;
pub const AX_FAILURE: AXError = -25200;
pub const AX_ILLEGAL_ARGUMENT: AXError = -25201;
pub const AX_INVALID_ELEMENT: AXError = -25202;
pub const AX_CANNOT_COMPLETE: AXError = -25204;
pub const AX_ATTRIBUTE_UNSUPPORTED: AXError = -25205;
pub const AX_ACTION_UNSUPPORTED: AXError = -25206;
pub const AX_NOT_IMPLEMENTED: AXError = -25208;
pub const AX_API_DISABLED: AXError = -25211;
pub const AX_NO_VALUE: AXError = -25212;

const VALUE_CGPOINT: u32 = 1;
const VALUE_CGSIZE: u32 = 2;
const VALUE_CFRANGE: u32 = 4;
const VALUE_AXERROR: u32 = 5;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGSize {
    width: f64,
    height: f64,
}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
    fn AXUIElementCreateSystemWide() -> CFTypeRef;
    fn AXUIElementCopyAttributeValue(element: CFTypeRef, attribute: CFStringRef, value: *mut CFTypeRef) -> AXError;
    fn AXUIElementCopyAttributeValues(element: CFTypeRef, attribute: CFStringRef, index: CFIndex, max: CFIndex, values: *mut CFArrayRef) -> AXError;
    fn AXUIElementGetAttributeValueCount(element: CFTypeRef, attribute: CFStringRef, count: *mut CFIndex) -> AXError;
    fn AXUIElementCopyMultipleAttributeValues(element: CFTypeRef, attributes: CFArrayRef, options: u32, values: *mut CFArrayRef) -> AXError;
    fn AXUIElementSetAttributeValue(element: CFTypeRef, attribute: CFStringRef, value: CFTypeRef) -> AXError;
    fn AXUIElementIsAttributeSettable(element: CFTypeRef, attribute: CFStringRef, settable: *mut Boolean) -> AXError;
    fn AXUIElementPerformAction(element: CFTypeRef, action: CFStringRef) -> AXError;
    fn AXUIElementCopyActionNames(element: CFTypeRef, names: *mut CFArrayRef) -> AXError;
    fn AXUIElementSetMessagingTimeout(element: CFTypeRef, seconds: f32) -> AXError;
    fn AXUIElementCopyElementAtPosition(application: CFTypeRef, x: f32, y: f32, element: *mut CFTypeRef) -> AXError;
    fn AXUIElementGetPid(element: CFTypeRef, pid: *mut i32) -> AXError;
    fn AXUIElementGetTypeID() -> CFTypeID;
    fn AXValueGetTypeID() -> CFTypeID;
    fn AXValueGetType(value: CFTypeRef) -> u32;
    fn AXValueGetValue(value: CFTypeRef, kind: u32, out: *mut c_void) -> Boolean;
    fn AXValueCreate(kind: u32, value: *const c_void) -> CFTypeRef;
    fn AXIsProcessTrusted() -> Boolean;
    /// Private, and stable since macOS 10.6: the window server's id of a window element.
    fn _AXUIElementGetWindow(element: CFTypeRef, id: *mut u32) -> AXError;
}

/// Whether this process may use the accessibility API.
pub fn trusted() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
}

/// Sets how long every request to another app may take before it fails with
/// `AX_CANNOT_COMPLETE`. Set once for the process: a request to an app that
/// hangs then ends in this time, and the reader's own deadline decides
/// what to do next.
pub fn set_global_timeout(seconds: f32) {
    let system = unsafe { AXUIElementCreateSystemWide() };
    if !system.is_null() {
        unsafe {
            AXUIElementSetMessagingTimeout(system, seconds);
            CFRelease(system);
        }
    }
}

/// An owned accessibility element.
pub struct Element(CFTypeRef);

// An AXUIElementRef is an immutable token naming an element in another
// process; CoreFoundation's retain and release are thread safe.
unsafe impl Send for Element {}
unsafe impl Sync for Element {}

impl Clone for Element {
    fn clone(&self) -> Self {
        unsafe { CFRetain(self.0) };
        Self(self.0)
    }
}

impl Drop for Element {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) };
    }
}

impl PartialEq for Element {
    fn eq(&self, other: &Self) -> bool {
        unsafe { CFEqual(self.0, other.0) != 0 }
    }
}

impl Eq for Element {}

impl Element {
    /// A key naming a sheet or window as a string the engine can hand back: its window server id, else `ax-` and the
    /// accessibility element's hash, which CoreFoundation keeps equal for elements that are equal.
    pub fn sheet_key(&self) -> String {
        match self.window_id() {
            Some(id) => id.to_string(),
            None => format!("ax-{:x}", unsafe { CFHash(self.0) }),
        }
    }
}

impl Hash for Element {
    fn hash<H: Hasher>(&self, state: &mut H) {
        unsafe { CFHash(self.0) }.hash(state);
    }
}

/// One attribute's value, decoded.
#[derive(Clone)]
pub enum Value {
    Text(String),
    Number(f64),
    Bool(bool),
    Element(Element),
    Array(Vec<Value>),
    Point(f64, f64),
    Size(f64, f64),
    /// A text range: its start and length, in UTF-16 units.
    Range(usize, usize),
    Other,
}

impl Value {
    pub fn text(&self) -> Option<&str> {
        match self {
            Value::Text(text) => Some(text),
            _ => None,
        }
    }

    pub fn boolean(&self) -> Option<bool> {
        match self {
            Value::Bool(value) => Some(*value),
            Value::Number(value) => Some(*value != 0.0),
            _ => None,
        }
    }

    pub fn element(&self) -> Option<&Element> {
        match self {
            Value::Element(element) => Some(element),
            _ => None,
        }
    }

    /// The value as the text a node shows: a string as it is, a number in its shortest form.
    pub fn display(&self) -> Option<String> {
        match self {
            Value::Text(text) => Some(text.clone()),
            Value::Number(number) => Some(format_number(*number)),
            Value::Bool(value) => Some(if *value { "1".into() } else { "0".into() }),
            _ => None,
        }
    }
}

/// A number as a node shows it: `1`, not `1.0`.
pub fn format_number(number: f64) -> String {
    if number.fract() == 0.0 && number.abs() < 1e15 { format!("{}", number as i64) } else { format!("{number}") }
}

/// Decodes one CoreFoundation value. `Err` carries an AX error a multiple-attribute read put in the value's place.
/// The values of a batch read, from what each slot decoded to. A batch that succeeds can still carry an error in one
/// slot: a gone element fails the whole read, and so does a stall, since a value the app did not answer in time is not
/// a value it lacks. Any other error is an attribute with no value.
fn slots(decoded: Vec<Result<Value, AXError>>) -> Result<Vec<Option<Value>>, AXError> {
    decoded
        .into_iter()
        .map(|slot| match slot {
            Ok(value) => Ok(Some(value)),
            Err(error @ (AX_INVALID_ELEMENT | AX_CANNOT_COMPLETE)) => Err(error),
            Err(_) => Ok(None),
        })
        .collect()
}

fn decode(value: CFTypeRef) -> Result<Value, AXError> {
    if value.is_null() {
        return Err(AX_NO_VALUE);
    }
    let kind = unsafe { CFGetTypeID(value) };
    unsafe {
        if kind == CFStringGetTypeID() {
            let string = CFString::wrap_under_get_rule(value as CFStringRef);
            return Ok(Value::Text(string.to_string()));
        }
        if kind == CFBoolean::type_id() {
            let boolean = CFBoolean::wrap_under_get_rule(value as _);
            return Ok(Value::Bool(boolean.into()));
        }
        if kind == CFNumber::type_id() {
            let number = CFNumber::wrap_under_get_rule(value as _);
            return Ok(number.to_f64().map(Value::Number).unwrap_or(Value::Other));
        }
        if kind == AXUIElementGetTypeID() {
            CFRetain(value);
            return Ok(Value::Element(Element(value)));
        }
        if kind == CFArray::<CFType>::type_id() {
            let array = value as CFArrayRef;
            let count = CFArrayGetCount(array);
            let mut items = Vec::with_capacity(count.max(0) as usize);
            for index in 0..count {
                if let Ok(item) = decode(CFArrayGetValueAtIndex(array, index)) {
                    items.push(item);
                }
            }
            return Ok(Value::Array(items));
        }
        if kind == AXValueGetTypeID() {
            match AXValueGetType(value) {
                VALUE_CGPOINT => {
                    let mut point = CGPoint::default();
                    AXValueGetValue(value, VALUE_CGPOINT, &mut point as *mut _ as *mut c_void);
                    return Ok(Value::Point(point.x, point.y));
                }
                VALUE_CGSIZE => {
                    let mut size = CGSize::default();
                    AXValueGetValue(value, VALUE_CGSIZE, &mut size as *mut _ as *mut c_void);
                    return Ok(Value::Size(size.width, size.height));
                }
                VALUE_CFRANGE => {
                    let mut range = CFRange { location: 0, length: 0 };
                    AXValueGetValue(value, VALUE_CFRANGE, &mut range as *mut _ as *mut c_void);
                    return Ok(Value::Range(range.location.max(0) as usize, range.length.max(0) as usize));
                }
                VALUE_AXERROR => {
                    let mut error: AXError = 0;
                    AXValueGetValue(value, VALUE_AXERROR, &mut error as *mut _ as *mut c_void);
                    return Err(error);
                }
                _ => return Ok(Value::Other),
            }
        }
    }
    Ok(Value::Other)
}

impl Element {
    /// The element for an app's process.
    pub fn application(pid: i32) -> Self {
        Self(unsafe { AXUIElementCreateApplication(pid) })
    }

    /// The system-wide element: what it finds at a point is whatever is on top there, of any app.
    pub fn system_wide() -> Self {
        Self(unsafe { AXUIElementCreateSystemWide() })
    }

    /// One attribute. `Err` is the AX error: `AX_NO_VALUE` or `AX_ATTRIBUTE_UNSUPPORTED` when it has none.
    pub fn attribute(&self, name: &str) -> Result<Value, AXError> {
        let key = CFString::new(name);
        let mut value: CFTypeRef = std::ptr::null();
        let error = unsafe { AXUIElementCopyAttributeValue(self.0, key.as_concrete_TypeRef(), &mut value) };
        if error != AX_SUCCESS {
            return Err(error);
        }
        // Success with no value out: nothing to decode or release.
        if value.is_null() {
            return Err(AX_NO_VALUE);
        }
        let decoded = decode(value);
        unsafe { CFRelease(value) };
        decoded
    }

    /// Several attributes in one request, each `None` when it has no value.
    /// `Err` when the whole request failed, the element is gone, or the app
    /// did not answer one of them in time.
    pub fn attributes(&self, names: &[&str]) -> Result<Vec<Option<Value>>, AXError> {
        let keys: Vec<CFString> = names.iter().map(|name| CFString::new(name)).collect();
        let array = CFArray::from_CFTypes(&keys);
        let mut values: CFArrayRef = std::ptr::null();
        let error = unsafe { AXUIElementCopyMultipleAttributeValues(self.0, array.as_concrete_TypeRef(), 0, &mut values) };
        if error != AX_SUCCESS {
            return Err(error);
        }
        if values.is_null() {
            return Ok(vec![None; names.len()]);
        }
        let count = unsafe { CFArrayGetCount(values) };
        let decoded: Vec<Result<Value, AXError>> = (0..names.len() as CFIndex)
            .map(|index| if index < count { decode(unsafe { CFArrayGetValueAtIndex(values, index) }) } else { Err(AX_NO_VALUE) })
            .collect();
        unsafe { CFRelease(values as CFTypeRef) };
        slots(decoded)
    }

    /// How many values an array attribute holds.
    pub fn count(&self, name: &str) -> Result<usize, AXError> {
        let key = CFString::new(name);
        let mut count: CFIndex = 0;
        let error = unsafe { AXUIElementGetAttributeValueCount(self.0, key.as_concrete_TypeRef(), &mut count) };
        if error != AX_SUCCESS { Err(error) } else { Ok(count.max(0) as usize) }
    }

    /// Up to `max` elements of an array attribute, from the first.
    pub fn elements(&self, name: &str, max: usize) -> Result<Vec<Element>, AXError> {
        let key = CFString::new(name);
        let mut values: CFArrayRef = std::ptr::null();
        let error = unsafe { AXUIElementCopyAttributeValues(self.0, key.as_concrete_TypeRef(), 0, max as CFIndex, &mut values) };
        if error != AX_SUCCESS {
            return Err(error);
        }
        if values.is_null() {
            return Ok(Vec::new());
        }
        let decoded = decode(values as CFTypeRef);
        unsafe { CFRelease(values as CFTypeRef) };
        Ok(match decoded {
            Ok(Value::Array(items)) => items.into_iter().filter_map(|item| if let Value::Element(element) = item { Some(element) } else { None }).collect(),
            _ => Vec::new(),
        })
    }

    pub fn text(&self, name: &str) -> Option<String> {
        self.attribute(name).ok().and_then(|value| value.text().map(str::to_owned))
    }

    pub fn boolean(&self, name: &str) -> Option<bool> {
        self.attribute(name).ok().and_then(|value| value.boolean())
    }

    pub fn element(&self, name: &str) -> Option<Element> {
        self.attribute(name).ok().and_then(|value| value.element().cloned())
    }

    /// The element's frame in screen points, top-left origin.
    pub fn frame(&self) -> Option<(f64, f64, f64, f64)> {
        self.read_frame().ok().flatten()
    }

    /// `frame`, failing with `AX_CANNOT_COMPLETE` when the app did not answer in time, and with `AX_INVALID_ELEMENT` when
    /// the element is gone: neither is proof the element has no frame. Any other error reads as none.
    pub fn read_frame(&self) -> Result<Option<(f64, f64, f64, f64)>, AXError> {
        let values = match self.attributes(&["AXPosition", "AXSize"]) {
            Ok(values) => values,
            Err(error @ (AX_CANNOT_COMPLETE | AX_INVALID_ELEMENT)) => return Err(error),
            Err(_) => return Ok(None),
        };
        Ok(match (&values[0], &values[1]) {
            (Some(Value::Point(x, y)), Some(Value::Size(width, height))) => Some((*x, *y, *width, *height)),
            _ => None,
        })
    }

    pub fn settable(&self, name: &str) -> Result<bool, AXError> {
        let key = CFString::new(name);
        let mut settable: Boolean = 0;
        let error = unsafe { AXUIElementIsAttributeSettable(self.0, key.as_concrete_TypeRef(), &mut settable) };
        if error != AX_SUCCESS { Err(error) } else { Ok(settable != 0) }
    }

    pub fn set_text(&self, name: &str, value: &str) -> Result<(), AXError> {
        let value = CFString::new(value);
        self.set(name, value.as_CFTypeRef())
    }

    pub fn set_bool(&self, name: &str, value: bool) -> Result<(), AXError> {
        let value = if value { CFBoolean::true_value() } else { CFBoolean::false_value() };
        self.set(name, value.as_CFTypeRef())
    }

    pub fn set_number(&self, name: &str, value: f64) -> Result<(), AXError> {
        let value = CFNumber::from(value);
        self.set(name, value.as_CFTypeRef())
    }

    /// Sets a text range attribute, such as `AXSelectedTextRange`, in UTF-16 units.
    pub fn set_range(&self, name: &str, location: usize, length: usize) -> Result<(), AXError> {
        let range = CFRange { location: location as CFIndex, length: length as CFIndex };
        let value = unsafe { AXValueCreate(VALUE_CFRANGE, &range as *const CFRange as *const c_void) };
        if value.is_null() {
            return Err(AX_FAILURE);
        }
        let result = self.set(name, value);
        unsafe { CFRelease(value) };
        result
    }

    pub fn set_elements(&self, name: &str, values: &[Element]) -> Result<(), AXError> {
        let raw: Vec<CFType> = values.iter().map(|element| unsafe { CFType::wrap_under_get_rule(element.0) }).collect();
        let array = CFArray::from_CFTypes(&raw);
        self.set(name, array.as_CFTypeRef())
    }

    fn set(&self, name: &str, value: CFTypeRef) -> Result<(), AXError> {
        let key = CFString::new(name);
        let error = unsafe { AXUIElementSetAttributeValue(self.0, key.as_concrete_TypeRef(), value) };
        if error != AX_SUCCESS { Err(error) } else { Ok(()) }
    }

    pub fn perform(&self, action: &str) -> Result<(), AXError> {
        let key = CFString::new(action);
        let error = unsafe { AXUIElementPerformAction(self.0, key.as_concrete_TypeRef()) };
        if error != AX_SUCCESS { Err(error) } else { Ok(()) }
    }

    pub fn actions(&self) -> Result<Vec<String>, AXError> {
        let mut names: CFArrayRef = std::ptr::null();
        let error = unsafe { AXUIElementCopyActionNames(self.0, &mut names) };
        if error != AX_SUCCESS {
            return Err(error);
        }
        if names.is_null() {
            return Ok(Vec::new());
        }
        let decoded = decode(names as CFTypeRef);
        unsafe { CFRelease(names as CFTypeRef) };
        Ok(match decoded {
            Ok(Value::Array(items)) => items.into_iter().filter_map(|item| if let Value::Text(text) = item { Some(text) } else { None }).collect(),
            _ => Vec::new(),
        })
    }

    /// Sets this element's own messaging timeout, for a request expected to wait (an action that opens a menu).
    pub fn set_timeout(&self, seconds: f32) {
        unsafe { AXUIElementSetMessagingTimeout(self.0, seconds) };
    }

    /// The id of the process the element belongs to.
    pub fn pid(&self) -> Option<i32> {
        let mut pid: i32 = 0;
        let error = unsafe { AXUIElementGetPid(self.0, &mut pid) };
        if error == AX_SUCCESS { Some(pid) } else { None }
    }

    /// The window server's id of a window element.
    pub fn window_id(&self) -> Option<u32> {
        let mut id: u32 = 0;
        let error = unsafe { _AXUIElementGetWindow(self.0, &mut id) };
        if error == AX_SUCCESS && id != 0 { Some(id) } else { None }
    }

    /// The element at a point on screen, of this app, or of any app on the system-wide element: `None` when none is
    /// there, `Err` when the app did not answer.
    pub fn element_at(&self, x: f64, y: f64) -> Result<Option<Element>, AXError> {
        let mut element: CFTypeRef = std::ptr::null();
        let error = unsafe { AXUIElementCopyElementAtPosition(self.0, x as f32, y as f32, &mut element) };
        match error {
            AX_SUCCESS if !element.is_null() => Ok(Some(Element(element))),
            AX_SUCCESS | AX_NO_VALUE => Ok(None),
            error => Err(error),
        }
    }
}

/// A readable name for an AX error, for messages.
pub fn describe(error: AXError) -> &'static str {
    match error {
        AX_FAILURE => "the app's accessibility answered with a failure",
        AX_ILLEGAL_ARGUMENT => "the app refused the value",
        AX_INVALID_ELEMENT => "the element no longer exists",
        AX_CANNOT_COMPLETE => "the app did not answer in time",
        AX_ATTRIBUTE_UNSUPPORTED => "the element has no such attribute",
        AX_ACTION_UNSUPPORTED => "the element does not take that action",
        AX_NOT_IMPLEMENTED => "the app does not implement accessibility for it",
        AX_API_DISABLED => "accessibility is not allowed for this process",
        AX_NO_VALUE => "the attribute has no value",
        _ => "the accessibility request failed",
    }
}

#[cfg(test)]
mod tests {
    use super::{AX_ATTRIBUTE_UNSUPPORTED, AX_CANNOT_COMPLETE, AX_INVALID_ELEMENT, AX_NO_VALUE, Value, slots};

    #[test]
    fn fails_a_batch_read_on_a_stalled_or_gone_slot_and_reads_any_other_error_as_no_value() {
        let read = slots(vec![Ok(Value::Text("Name".into())), Err(AX_NO_VALUE), Err(AX_ATTRIBUTE_UNSUPPORTED)]).expect("a read");
        assert!(matches!(read.as_slice(), [Some(Value::Text(_)), None, None]));
        assert_eq!(slots(vec![Ok(Value::Text("Name".into())), Err(AX_CANNOT_COMPLETE)]).err(), Some(AX_CANNOT_COMPLETE));
        assert_eq!(slots(vec![Err(AX_INVALID_ELEMENT), Ok(Value::Bool(true))]).err(), Some(AX_INVALID_ELEMENT));
    }
}
