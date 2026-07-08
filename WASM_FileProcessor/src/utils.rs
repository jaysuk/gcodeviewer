// Ultra-fast number parsing optimized for G-code
// This parser is designed to be much faster than Rust's standard parse() method
// by avoiding string allocations and using direct byte manipulation

use crate::gcode_line::Vector3;

#[derive(Debug, Clone, Copy)]
pub struct ParseResult {
    pub value: f64,
    pub consumed_bytes: usize,
}

impl ParseResult {
    pub fn new(value: f64, consumed_bytes: usize) -> Self {
        Self { value, consumed_bytes }
    }
}

/// Ultra-fast floating point number parser optimized for G-code
/// Returns (value, bytes_consumed)
pub fn parse_number_fast(bytes: &[u8], start_idx: usize) -> Option<ParseResult> {
    if start_idx >= bytes.len() {
        return None;
    }
    
    let mut idx = start_idx;
    let len = bytes.len();
    
    // Skip whitespace
    while idx < len && bytes[idx] == b' ' {
        idx += 1;
    }
    
    if idx >= len {
        return None;
    }
    
    let mut negative = false;
    let mut integer_part: u64 = 0;
    let mut decimal_part: u64 = 0;
    let mut decimal_places: u32 = 0;
    let mut has_decimal = false;
    let mut found_digit = false;
    
    // Handle sign
    if bytes[idx] == b'-' {
        negative = true;
        idx += 1;
    } else if bytes[idx] == b'+' {
        idx += 1;
    }
    
    // Parse integer part
    while idx < len {
        let byte = bytes[idx];
        match byte {
            b'0'..=b'9' => {
                found_digit = true;
                let digit = (byte - b'0') as u64;
                
                // Prevent overflow - if we're getting too large, use f64 parsing
                if integer_part > u64::MAX / 10 {
                    return fallback_parse(bytes, start_idx);
                }
                
                integer_part = integer_part * 10 + digit;
                idx += 1;
            }
            b'.' => {
                if has_decimal {
                    break; // Second decimal point, stop parsing
                }
                has_decimal = true;
                idx += 1;
                break;
            }
            _ => break, // Non-digit, non-decimal character
        }
    }
    
    // Parse decimal part if we found a decimal point
    if has_decimal {
        while idx < len && decimal_places < 10 { // Limit precision to prevent overflow
            let byte = bytes[idx];
            match byte {
                b'0'..=b'9' => {
                    found_digit = true;
                    let digit = (byte - b'0') as u64;
                    decimal_part = decimal_part * 10 + digit;
                    decimal_places += 1;
                    idx += 1;
                }
                _ => break, // Non-digit character
            }
        }
        
        // Skip any remaining digits to advance the index properly
        while idx < len && bytes[idx].is_ascii_digit() {
            idx += 1;
        }
    }
    
    if !found_digit {
        return None;
    }
    
    // Convert to float
    let mut result = integer_part as f64;
    
    if has_decimal && decimal_places > 0 {
        let divisor = 10_u64.pow(decimal_places) as f64;
        result += decimal_part as f64 / divisor;
    }
    
    if negative {
        result = -result;
    }
    
    Some(ParseResult::new(result, idx - start_idx))
}

// Fallback parser using standard library (for edge cases)
fn fallback_parse(bytes: &[u8], start_idx: usize) -> Option<ParseResult> {
    let mut end_idx = start_idx;
    
    // Find the end of the number
    while end_idx < bytes.len() {
        match bytes[end_idx] {
            b'0'..=b'9' | b'.' | b'-' | b'+' | b'e' | b'E' => end_idx += 1,
            _ => break,
        }
    }
    
    if end_idx == start_idx {
        return None;
    }
    
    // Convert to string and parse
    if let Ok(s) = std::str::from_utf8(&bytes[start_idx..end_idx]) {
        if let Ok(value) = s.parse::<f64>() {
            return Some(ParseResult::new(value, end_idx - start_idx));
        }
    }
    
    None
}

/// Parse a G-code parameter (letter followed by number)
/// Returns (letter, value, bytes_consumed)
pub fn parse_parameter(bytes: &[u8], start_idx: usize) -> Option<(char, f64, usize)> {
    if start_idx >= bytes.len() {
        return None;
    }
    
    let letter_byte = bytes[start_idx];
    
    // Must start with a letter
    if !letter_byte.is_ascii_alphabetic() {
        return None;
    }
    
    let letter = letter_byte.to_ascii_uppercase() as char;
    
    // Parse the number after the letter
    if let Some(parse_result) = parse_number_fast(bytes, start_idx + 1) {
        Some((letter, parse_result.value, 1 + parse_result.consumed_bytes))
    } else {
        None
    }
}

/// Split a line into tokens starting with letters
pub fn tokenize_gcode_line(line: &str) -> Vec<&str> {
    let bytes = line.as_bytes();
    let mut tokens = Vec::new();
    let mut start = 0;
    
    // Skip leading whitespace
    while start < bytes.len() && bytes[start] == b' ' {
        start += 1;
    }
    
    let mut i = start;
    while i < bytes.len() {
        // If we find a letter, this might be the start of a new token
        if bytes[i].is_ascii_alphabetic() && i > start {
            // Add the previous token
            if start < i {
                tokens.push(&line[start..i]);
            }
            start = i;
        }
        i += 1;
    }
    
    // Add the last token
    if start < bytes.len() {
        tokens.push(&line[start..]);
    }
    
    tokens
}

/// Check if a line is a comment (starts with ; or is empty/whitespace)
pub fn is_comment_line(line: &str) -> bool {
    let trimmed = line.trim();
    trimmed.is_empty() || trimmed.starts_with(';')
}

/// Extract comment text from a comment line
pub fn extract_comment(line: &str) -> &str {
    let trimmed = line.trim();
    if trimmed.starts_with(';') {
        trimmed[1..].trim()
    } else {
        trimmed
    }
}

/// Fast G-code command detection
pub fn detect_gcode_command(line: &str) -> Option<&str> {
    let bytes = line.as_bytes();
    let mut i = 0;
    
    // Skip leading whitespace
    while i < bytes.len() && bytes[i] == b' ' {
        i += 1;
    }
    
    if i >= bytes.len() {
        return None;
    }
    
    // Must start with G, M, or T
    let first_char = bytes[i];
    if first_char != b'G' && first_char != b'g' && 
       first_char != b'M' && first_char != b'm' &&
       first_char != b'T' && first_char != b't' {
        return None;
    }
    
    let start = i;
    i += 1;

    // RepRapFirmware's `T-1` (deselect all tools) is the one command letter that takes a negative
    // number - without this, `T-1` never reaches the tool-number parser at all: the digit scan
    // below stops immediately at '-', `i` never advances past `start + 1`, and the line falls
    // through as an unrecognized/comment line further up the call chain.
    if (first_char == b'T' || first_char == b't') && i < bytes.len() && bytes[i] == b'-' {
        i += 1;
    }

    // Parse number after the letter
    while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
        i += 1;
    }

    if i > start + 1 {
        Some(&line[start..i])
    } else {
        None
    }
}

/// Calculate distance between two 3D points
pub fn distance_3d(p1: &[f64; 3], p2: &[f64; 3]) -> f64 {
    let dx = p1[0] - p2[0];
    let dy = p1[1] - p2[1];
    let dz = p1[2] - p2[2];
    (dx * dx + dy * dy + dz * dz).sqrt()
}

/// Normalize a 3D vector
pub fn normalize_3d(v: &[f64; 3]) -> [f64; 3] {
    let length = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if length > 0.0 {
        [v[0] / length, v[1] / length, v[2] / length]
    } else {
        [0.0, 0.0, 0.0]
    }
}

/// Fast string to uppercase conversion for G-code commands
pub fn to_uppercase_ascii(s: &str) -> String {
    s.chars()
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

/// Skip whitespace characters and return new position
pub fn skip_whitespace(bytes: &[u8], mut pos: usize) -> usize {
    while pos < bytes.len() && (bytes[pos] == b' ' || bytes[pos] == b'\t') {
        pos += 1;
    }
    pos
}

/// Parse number from string (wrapper for compatibility)
pub fn parse_number_from_str(line: &str, start_pos: usize) -> Result<(f64, usize), String> {
    let bytes = line.as_bytes();
    if let Some(result) = parse_number_fast(bytes, start_pos) {
        Ok((result.value, start_pos + result.consumed_bytes))
    } else {
        Err("Failed to parse number".to_string())
    }
}

/// Arc tessellation result containing intermediate points
#[derive(Debug, Clone)]
pub struct ArcResult {
    pub final_position: Vector3,
    pub intermediate_points: Vec<Vector3>,
}

/// Arc plane specification
#[derive(Debug, Clone, Copy)]
pub enum ArcPlane {
    XY,
    XZ, 
    YZ,
}

/// Generate tessellated points for G2/G3 arc moves - a faithful port of TypeScript's doArc
/// (src/util.ts). `start_babylon`/`end_babylon` must already be fully resolved (workplace offset
/// and absolute/relative applied - see G2G3.rs's parse_arc_move, which mirrors G0G1.rs's own
/// per-axis resolution); `i_offset`/`j_offset`/`k_offset` are raw, un-swapped, un-offset literal
/// token values (TS's getNumber(token, i, false, 0) never applies workplace/relative logic to
/// I/J/K/R - only X/Y/Z get that treatment).
///
/// Returns Ok with an EMPTY point list (not an Err) for every case doArc itself doesn't throw for
/// - "radius too small" included. The caller (G2G3.rs) must not advance current_position when the
/// result is empty, exactly like g2g3.ts's `curPt` accumulator: it starts at the pre-arc position
/// and is only overwritten by iterating `arcResult.points`, so if tessellation produces zero
/// points the position silently doesn't move at all, regardless of what X/Y/Z was parsed.
pub fn tessellate_arc(
    start_babylon: Vector3,
    end_babylon: Vector3,
    i_offset: f64,
    j_offset: f64,
    k_offset: f64,
    radius: Option<f64>,
    is_clockwise: bool,
    arc_plane: ArcPlane,
    arc_segment_length: f64,
    fix_radius: bool,
) -> ArcResult {
    // Un-swap Babylon (x, y=height, z=gcodeY) -> gcode (x, y, z) space, matching doArc's
    // `current = new Vector3(currentPosition.x, currentPosition.z, currentPosition.y)`
    let current = [start_babylon.x, start_babylon.z, start_babylon.y];
    let target = [end_babylon.x, end_babylon.z, end_babylon.y];

    let mut i = i_offset;
    let mut j = j_offset;
    let k = k_offset;

    // Axis routing per arc plane - matches util.ts's doArc exactly, including the XZ/YZ I/J/K
    // re-routing (this is NOT a simple i/j swap for XZ, as an earlier version of this port
    // assumed - it specifically pulls the axis0 offset from K and axis1 offset from the original I)
    let (axis0, axis1, axis2) = match arc_plane {
        ArcPlane::XY => (0usize, 1usize, 2usize),
        ArcPlane::XZ => {
            let original_i = i;
            i = k; // axis0 (z) offset comes from K
            j = original_i; // axis1 (x) offset comes from I
            (2, 0, 1)
        }
        ArcPlane::YZ => {
            i = j; // axis0 (y) offset comes from J
            j = k; // axis1 (z) offset comes from K
            (1, 2, 0)
        }
    };

    // Handle radius-based arc specification (R parameter)
    if let Some(r) = radius {
        let delta0 = target[axis0] - current[axis0];
        let delta1 = target[axis1] - current[axis1];

        let d_squared = delta0 * delta0 + delta1 * delta1;
        if d_squared == 0.0 {
            // Matches doArc: `return { position: current.clone(), points: [] }` - the position
            // field is never actually read by the caller, only the empty points list matters
            return ArcResult { final_position: start_babylon, intermediate_points: vec![] };
        }

        let mut h_squared = r * r - d_squared / 4.0;
        // Stays 0.0 (not computed) when h_squared is negative but within the -2% tolerance band -
        // matches doArc's `let hDivD = 0` default, which the `else` branch only overwrites when
        // it goes on to the fixRadius/error path, not for the borderline-negative case
        let mut h_div_d = 0.0;

        if h_squared >= 0.0 {
            h_div_d = (h_squared / d_squared).sqrt();
        } else if h_squared < -0.02 * r * r {
            if fix_radius {
                let min_r = ((delta0 / 2.0).powi(2) + (delta1 / 2.0).powi(2)).sqrt();
                h_squared = min_r * min_r - d_squared / 4.0;
                h_div_d = (h_squared / d_squared).sqrt();
            } else {
                // doArc logs and returns the TARGET position with empty points here (not an
                // exception) - but since the caller never reads the position field, this is
                // behaviorally identical to any other empty-points case
                return ArcResult { final_position: end_babylon, intermediate_points: vec![] };
            }
        }

        if (is_clockwise && r < 0.0) || (!is_clockwise && r > 0.0) {
            h_div_d = -h_div_d;
        }

        i = delta0 / 2.0 + delta1 * h_div_d;
        j = delta1 / 2.0 - delta0 * h_div_d;
    } else if i == 0.0 && j == 0.0 {
        // Center point is offset from current position - need at least one of I/J
        return ArcResult { final_position: start_babylon, intermediate_points: vec![] };
    }

    let whole_circle = current[axis0] == target[axis0] && current[axis1] == target[axis1];

    let center0 = current[axis0] + i;
    let center1 = current[axis1] + j;

    let arc_radius = (i * i + j * j).sqrt();
    let arc_current_angle = (-j).atan2(-i);
    let final_theta = (target[axis1] - center1).atan2(target[axis0] - center0);

    let total_arc = if whole_circle {
        2.0 * std::f64::consts::PI
    } else {
        let mut arc = if is_clockwise {
            arc_current_angle - final_theta
        } else {
            final_theta - arc_current_angle
        };
        if arc < 0.0 {
            arc += 2.0 * std::f64::consts::PI;
        }
        arc
    };

    let mut total_segments = (arc_radius * total_arc) / arc_segment_length;
    if total_segments < 1.0 {
        total_segments = 1.0;
    }
    // total_segments stays a float through the loop bound and increment division, matching TS
    // exactly (`for (let moveIdx = 0; moveIdx < totalSegments - 1; moveIdx++)`) rather than
    // truncating to an integer segment count up front, which would round differently.

    let arc_angle_increment = (total_arc / total_segments) * if is_clockwise { -1.0 } else { 1.0 };

    let axis2_dist = target[axis2] - current[axis2];
    let axis2_step = axis2_dist / total_segments;

    let mut points = Vec::new();
    let mut current_angle = arc_current_angle;
    let mut p2 = current[axis2];

    let mut move_idx: f64 = 0.0;
    while move_idx < total_segments - 1.0 {
        current_angle += arc_angle_increment;
        let p0 = center0 + arc_radius * current_angle.cos();
        let p1 = center1 + arc_radius * current_angle.sin();
        p2 += axis2_step;

        let mut world = [0.0f64; 3];
        world[axis0] = p0;
        world[axis1] = p1;
        world[axis2] = p2;

        // Re-swap gcode -> Babylon space
        points.push(Vector3 { x: world[0], y: world[2], z: world[1] });
        move_idx += 1.0;
    }

    points.push(end_babylon.clone());

    ArcResult {
        final_position: end_babylon,
        intermediate_points: points,
    }
}

// Performance testing utilities
#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_parse_number_fast() {
        let test_cases = vec![
            ("123", Some(123.0)),
            ("123.456", Some(123.456)),
            ("-45.67", Some(-45.67)),
            ("+89.12", Some(89.12)),
            ("  42  ", Some(42.0)),
            ("0.001", Some(0.001)),
            ("1000000", Some(1000000.0)),
            ("invalid", None),
            ("", None),
        ];
        
        for (input, expected) in test_cases {
            let bytes = input.as_bytes();
            let result = parse_number_fast(bytes, 0);
            
            match (result, expected) {
                (Some(ParseResult { value, .. }), Some(expected_val)) => {
                    assert!((value - expected_val).abs() < 1e-10, 
                           "Failed for input '{}': expected {}, got {}", input, expected_val, value);
                }
                (None, None) => {} // Both None, test passed
                _ => panic!("Failed for input '{}': expected {:?}, got {:?}", input, expected, result),
            }
        }
    }
    
    #[test]
    fn test_parse_parameter() {
        let test_cases = vec![
            ("X123.45", Some(('X', 123.45, 7))),
            ("Y-67.89", Some(('Y', -67.89, 7))),
            ("Z0.1", Some(('Z', 0.1, 4))),
            ("F1500", Some(('F', 1500.0, 5))),
            ("E0.05", Some(('E', 0.05, 5))),
            ("123", None), // No letter
            ("", None),
        ];
        
        for (input, expected) in test_cases {
            let bytes = input.as_bytes();
            let result = parse_parameter(bytes, 0);
            
            match (result, expected) {
                (Some((letter, value, consumed)), Some((exp_letter, exp_value, exp_consumed))) => {
                    assert_eq!(letter, exp_letter);
                    assert!((value - exp_value).abs() < 1e-10);
                    assert_eq!(consumed, exp_consumed);
                }
                (None, None) => {} // Both None, test passed
                _ => panic!("Failed for input '{}': expected {:?}, got {:?}", input, expected, result),
            }
        }
    }
    
    #[test]
    fn test_is_comment_line() {
        assert!(is_comment_line("; This is a comment"));
        assert!(is_comment_line("  ; Another comment  "));
        assert!(is_comment_line(""));
        assert!(is_comment_line("   "));
        assert!(!is_comment_line("G0 X10"));
        assert!(!is_comment_line("M104 S200"));
    }
    
    #[test]
    fn test_detect_gcode_command() {
        assert_eq!(detect_gcode_command("G0 X10 Y20"), Some("G0"));
        assert_eq!(detect_gcode_command("  G1  X5"), Some("G1"));
        assert_eq!(detect_gcode_command("M104 S200"), Some("M104"));
        assert_eq!(detect_gcode_command("T1"), Some("T1"));
        assert_eq!(detect_gcode_command("; comment"), None);
        assert_eq!(detect_gcode_command(""), None);
    }
}