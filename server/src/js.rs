//! Petites primitives reproduisant la sémantique JavaScript (coercitions,
//! valeurs « truthy », conversion en chaîne). L'API Node d'origine s'appuyait
//! sur ces règles pour valider les payloads : les reproduire évite tout
//! changement de comportement visible par le client React ou la tablette GPS.

use serde_json::{Map, Number, Value};

/// Équivalent de `Number(value)`. `None` représente `undefined`.
pub fn to_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => string_to_number(s),
        Some(Value::Array(items)) => match items.len() {
            0 => 0.0,
            1 => match &items[0] {
                Value::Null => 0.0,
                Value::Object(_) => f64::NAN,
                other => to_number(Some(other)),
            },
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

fn is_js_whitespace(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

/// Équivalent de `Number(string)`.
pub fn string_to_number(s: &str) -> f64 {
    let t = s.trim_matches(is_js_whitespace);
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let lower = t.to_ascii_lowercase();
    for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] {
        if let Some(digits) = lower.strip_prefix(prefix) {
            if digits.is_empty() {
                return f64::NAN;
            }
            let mut acc = 0f64;
            for c in digits.chars() {
                match c.to_digit(radix) {
                    Some(d) => acc = acc * radix as f64 + d as f64,
                    None => return f64::NAN,
                }
            }
            return acc;
        }
    }
    if !t
        .chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '.' | 'e' | 'E' | '+' | '-'))
    {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// Équivalent de `Boolean(value)`. `None` représente `undefined`.
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// Équivalent de `String(number)`.
pub fn num_to_string(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if f == 0.0 {
        return "0".into();
    }
    let abs = f.abs();
    if (1e-6..1e21).contains(&abs) {
        if f.fract() == 0.0 {
            format!("{f:.0}")
        } else {
            format!("{f}")
        }
    } else {
        let s = format!("{f:e}");
        match s.split_once('e') {
            Some((mantissa, exp)) if !exp.starts_with('-') => format!("{mantissa}e+{exp}"),
            _ => s,
        }
    }
}

/// Équivalent de `String(value)`. `None` représente `undefined`.
pub fn to_js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) if i.unsigned_abs() < (1u64 << 53) => i.to_string(),
            (_, Some(u)) if u < (1u64 << 53) => u.to_string(),
            _ => num_to_string(n.as_f64().unwrap_or(f64::NAN)),
        },
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => to_js_string(Some(other)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// Convertit un nombre JS en valeur JSON (`NaN`/`Infinity` deviennent `null`,
/// comme avec `JSON.stringify`).
pub fn number_value(f: f64) -> Value {
    if f.is_finite() && f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 {
        Value::from(f as i64)
    } else {
        Number::from_f64(f)
            .map(Value::Number)
            .unwrap_or(Value::Null)
    }
}

/// Convertit un `f32` lu en base en `f64` sans artefact de précision
/// (`1.1f32` devient `1.1` et non `1.100000023841858`).
pub fn clean_f32(f: f32) -> Value {
    format!("{f}")
        .parse::<f64>()
        .map(number_value)
        .unwrap_or(Value::Null)
}

fn is_array_index(key: &str) -> bool {
    if key == "0" {
        return true;
    }
    !key.is_empty()
        && !key.starts_with('0')
        && key.bytes().all(|b| b.is_ascii_digit())
        && key.parse::<u64>().is_ok_and(|n| n < 4_294_967_295)
}

/// Réordonne les clés comme le ferait un objet JS : clés entières croissantes
/// d'abord, puis les autres dans l'ordre d'insertion.
pub fn js_key_order(map: Map<String, Value>) -> Map<String, Value> {
    let mut indexes = Vec::new();
    let mut others = Vec::new();
    for (key, value) in map {
        if is_array_index(&key) {
            indexes.push((key, value));
        } else {
            others.push((key, value));
        }
    }
    indexes.sort_by_key(|(key, _)| key.parse::<u64>().unwrap_or(0));
    indexes.into_iter().chain(others).collect()
}

/// Équivalent de l'opérateur `+` utilisé comme accumulateur (`acc += value`).
pub fn js_add(acc: Value, value: Option<&Value>) -> Value {
    let is_stringy = |v: Option<&Value>| {
        matches!(
            v,
            Some(Value::String(_)) | Some(Value::Array(_)) | Some(Value::Object(_))
        )
    };
    if is_stringy(Some(&acc)) || is_stringy(value) {
        let left = to_js_string(Some(&acc));
        Value::String(left + &to_js_string(value))
    } else {
        number_value(to_number(Some(&acc)) + to_number(value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn number_coercion() {
        assert_eq!(to_number(Some(&json!("12.5"))), 12.5);
        assert_eq!(to_number(Some(&json!(" 3 "))), 3.0);
        assert_eq!(to_number(Some(&json!(""))), 0.0);
        assert_eq!(to_number(Some(&json!(null))), 0.0);
        assert_eq!(to_number(Some(&json!("0x10"))), 16.0);
        assert!(to_number(Some(&json!("abc"))).is_nan());
        assert!(to_number(Some(&json!("inf"))).is_nan());
        assert!(to_number(None).is_nan());
        assert!(to_number(Some(&json!({}))).is_nan());
    }

    #[test]
    fn strings() {
        assert_eq!(to_js_string(Some(&json!(6290))), "6290");
        assert_eq!(to_js_string(Some(&json!(1.5))), "1.5");
        assert_eq!(to_js_string(None), "undefined");
        assert_eq!(to_js_string(Some(&json!(null))), "null");
        assert_eq!(num_to_string(2.0), "2");
        assert_eq!(num_to_string(1e21), "1e+21");
        assert_eq!(num_to_string(1.5e-7), "1.5e-7");
        assert_eq!(num_to_string(0.1), "0.1");
    }

    #[test]
    fn truthiness() {
        assert!(!truthy(Some(&json!(0))));
        assert!(!truthy(Some(&json!(""))));
        assert!(truthy(Some(&json!("0"))));
        assert!(truthy(Some(&json!([]))));
        assert!(!truthy(None));
    }

    #[test]
    fn key_order() {
        let mut map = Map::new();
        map.insert("b".into(), json!(1));
        map.insert("7724".into(), json!(2));
        map.insert("6290".into(), json!(3));
        map.insert("a".into(), json!(4));
        let keys: Vec<_> = js_key_order(map).keys().cloned().collect();
        assert_eq!(keys, ["6290", "7724", "b", "a"]);
    }

    #[test]
    fn float_cleanup() {
        assert_eq!(clean_f32(1.1), json!(1.1));
        assert_eq!(clean_f32(2.0), json!(2));
    }

    #[test]
    fn addition() {
        assert_eq!(js_add(json!(0), Some(&json!(1.5))), json!(1.5));
        assert_eq!(
            js_add(json!(0), Some(&json!({"value": 1}))),
            json!("0[object Object]")
        );
    }
}
