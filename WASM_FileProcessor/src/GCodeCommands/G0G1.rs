use crate::gcode_line::{GCodeLine, MoveData, Vector3, Color4};
use crate::processor_properties::ProcessorProperties;
use crate::utils::parse_parameter;

/// Ultra-fast G0/G1 move parser optimized for the most common G-code commands
/// This parser handles ~80% of G-code lines and is heavily optimized for speed
pub fn parse_g0_g1_move(
    props: &mut ProcessorProperties, 
    line: &str, 
    file_position: u32, 
    line_number: u32
) -> Result<GCodeLine, String> {
    
    let bytes = line.as_bytes();
    let mut move_data = MoveData::new(file_position, line_number, line.to_string());
    
    // Copy current position as start position
    move_data.start = props.current_position.clone();
    move_data.tool = props.current_tool.tool_number;
    
    // Initialize with current position (will be updated by parameters)
    let mut x = props.current_position.x;
    let mut y = props.current_position.y;
    let mut z = props.current_position.z;
    let mut e: Option<f64> = None;
    let mut f: Option<f64> = None;
    let mut is_g1 = false;
    let mut force_absolute = false;
    
    // Parse the line character by character for maximum speed
    let mut i = 0;
    let len = bytes.len();
    
    // Fast scan through the line
    while i < len {
        // Skip whitespace
        while i < len && bytes[i] == b' ' {
            i += 1;
        }
        
        if i >= len {
            break;
        }
        
        let param_start = i;
        
        // Try to parse a parameter
        if let Some((letter, value, consumed)) = parse_parameter(bytes, i) {
            i += consumed;
            
            match letter {
                'G' => {
                    let g_num = value as u32;
                    match g_num {
                        0 => is_g1 = false,  // G0 - rapid move
                        1 => is_g1 = true,   // G1 - linear move
                        53 => force_absolute = true, // G53 - machine coordinates
                        _ => {} // Other G-codes, ignore for now
                    }
                }
                'X' => {
                    if props.z_belt {
                        // For Z-belt, X coordinate is absolute
                        x = value;
                    } else {
                        x = if props.absolute_positioning || force_absolute {
                            value + props.current_workplace().x
                        } else {
                            props.current_position.x + value
                        };
                    }
                }
                'Y' => {
                    if props.z_belt {
                        // For Z-belt, Y value is transformed
                        let new_y = value * props.hyp;
                        y = new_y;
                        z = props.current_z + new_y * props.adj;
                    } else {
                        // CRITICAL FIX: Y coordinate goes to Z position (matching TypeScript line 47-50)
                        z = if props.absolute_positioning || force_absolute {
                            value + props.current_workplace().y
                        } else {
                            props.current_position.z + value
                        };
                    }
                }
                'Z' => {
                    if props.z_belt {
                        // For Z-belt, Z value updates current_z and recalculates Z
                        props.current_z = -value;
                        z = props.current_z + y * props.adj;
                    } else {
                        // CRITICAL FIX: Z coordinate goes to Y position (matching TypeScript line 58-61)
                        y = if props.absolute_positioning || force_absolute {
                            value + props.current_workplace().z
                        } else {
                            props.current_position.y + value
                        };
                    }
                }
                'E' => {
                    e = Some(value);
                    if value > 0.0 {
                        move_data.extruding = true;
                    }
                }
                'F' => {
                    f = Some(value);
                }
                _ => {
                    // Unknown parameter, skip
                }
            }
        } else {
            // Not a valid parameter, advance one character
            i += 1;
        }
    }
    
    // Update processor state - coordinate swap now happens during parsing (above)
    props.current_position.x = x;
    props.current_position.y = y;  // Already swapped during parsing
    props.current_position.z = z;  // Already swapped during parsing
    
    // Set end position
    move_data.end = props.current_position.clone();
    
    // Handle G1 vs G0 differences
    if is_g1 {
        // Use slicer feature color instead of tool color for proper rendering
        move_data.color = props.current_feature_color.clone();
        move_data.extruding = move_data.extruding || props.cnc_mode;
    }
    
    // Set slicer feature flags
    move_data.is_perimeter = props.current_is_perimeter;
    move_data.is_support = props.current_is_support;
    
    // Set color ID for picking (matches TypeScript numToColor)
    move_data.color_id = [
        ((line_number >> 16) & 0xFF) as u8,  // Red channel
        ((line_number >> 8) & 0xFF) as u8,   // Green channel 
        (line_number & 0xFF) as u8,          // Blue channel
    ];
    
    // Handle extrusion
    if let Some(e_value) = e {
        if e_value > 0.0 {
            move_data.extruding = true;
        }
    }
    
    // Set move type based on extrusion
    if !move_data.extruding {
        move_data.tool = 255; // Travel moves use tool 255
    }
    
    // Handle feed rate
    if let Some(f_value) = f {
        if move_data.extruding {
            props.update_feed_rate(f_value);
        }
    }
    
    move_data.feed_rate = props.current_feed_rate;
    
    // Update height tracking
    props.update_height(move_data.end.z);
    
    // Update total segment count
    props.total_rendered_segments += 1;
    
    // Update first/last G-code byte tracking
    if props.first_gcode_byte == 0 && move_data.extruding {
        props.first_gcode_byte = file_position;
    }
    if move_data.extruding {
        props.last_gcode_byte = file_position;
    }
    
    Ok(GCodeLine::Move(move_data))
}

/// Fast detection of G0/G1 commands
/// Returns true only for an exact G0/G1/G00/G01 command token (not G10, G11, G28, ...)
pub fn is_g0_g1_command(line: &str) -> bool {
    let trimmed = line.trim();
    let bytes = trimmed.as_bytes();

    if bytes.len() < 2 {
        return false;
    }

    // Must start with G or g
    if bytes[0] != b'G' && bytes[0] != b'g' {
        return false;
    }

    // Scan the full digit run after 'G' so "G10 ..." isn't mistaken for "G1" followed by "0 ..."
    let mut i = 1;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }

    if i == 1 {
        return false; // no digits after G
    }

    let terminator_ok = i == bytes.len() || bytes[i] == b' ';
    if !terminator_ok {
        return false;
    }

    matches!(&trimmed[1..i], "0" | "00" | "1" | "01")
}

/// Extract G-code command number from line
/// Returns the G-code number if found (e.g., 0 for G0, 1 for G1)
pub fn extract_g_command_number(line: &str) -> Option<u32> {
    let bytes = line.trim().as_bytes();
    
    if bytes.len() < 2 || (bytes[0] != b'G' && bytes[0] != b'g') {
        return None;
    }
    
    let mut num = 0u32;
    let mut found_digit = false;
    
    for &byte in &bytes[1..] {
        match byte {
            b'0'..=b'9' => {
                found_digit = true;
                num = num * 10 + (byte - b'0') as u32;
            }
            b' ' => break, // Space ends the command
            _ => break,    // Other characters end the command
        }
    }
    
    if found_digit {
        Some(num)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_is_g0_g1_command() {
        assert!(is_g0_g1_command("G0 X10 Y20"));
        assert!(is_g0_g1_command("G1 X10 Y20 E0.1"));
        assert!(is_g0_g1_command("G00 X10"));
        assert!(is_g0_g1_command("G01 Y20"));
        assert!(is_g0_g1_command("g0 x10"));
        assert!(is_g0_g1_command("g1 y20"));
        
        assert!(!is_g0_g1_command("G2 X10 Y20"));
        assert!(!is_g0_g1_command("M104 S200"));
        assert!(!is_g0_g1_command("; comment"));
        assert!(!is_g0_g1_command(""));

        // Must not match commands that merely start with the same digits (regression: G10 was
        // previously misdetected as G1 followed by "0 ...")
        assert!(!is_g0_g1_command("G10 P1 X0 Y0"));
        assert!(!is_g0_g1_command("G11"));
        assert!(!is_g0_g1_command("G28"));
        assert!(!is_g0_g1_command("G02 X10 Y20"));
    }
    
    #[test]
    fn test_extract_g_command_number() {
        assert_eq!(extract_g_command_number("G0 X10"), Some(0));
        assert_eq!(extract_g_command_number("G1 Y20"), Some(1));
        assert_eq!(extract_g_command_number("G00 X10"), Some(0));
        assert_eq!(extract_g_command_number("G01 Y20"), Some(1));
        assert_eq!(extract_g_command_number("G28"), Some(28));
        assert_eq!(extract_g_command_number("G90"), Some(90));
        
        assert_eq!(extract_g_command_number("M104"), None);
        assert_eq!(extract_g_command_number("T1"), None);
        assert_eq!(extract_g_command_number(""), None);
    }
    
    #[test]
    fn test_parse_g0_g1_move_basic() {
        let mut props = ProcessorProperties::new();
        
        // Test G0 move
        let result = parse_g0_g1_move(&mut props, "G0 X10 Y20 Z5", 100, 1);
        assert!(result.is_ok());
        
        if let Ok(GCodeLine::Move(move_data)) = result {
            assert_eq!(move_data.end.x, 10.0);
            assert_eq!(move_data.end.z, 20.0); // Remember Y->Z mapping
            assert_eq!(move_data.end.y, 5.0);  // Remember Z->Y mapping
            assert!(!move_data.extruding); // G0 doesn't extrude by default
        }
        
        // Test G1 move with extrusion
        let result = parse_g0_g1_move(&mut props, "G1 X15 Y25 E0.1 F1500", 200, 2);
        assert!(result.is_ok());
        
        if let Ok(GCodeLine::Move(move_data)) = result {
            assert_eq!(move_data.end.x, 15.0);
            assert_eq!(move_data.end.z, 25.0); // Y->Z mapping
            assert!(move_data.extruding); // Should be extruding due to E parameter
            assert_eq!(move_data.feed_rate, 1500.0);
        }
    }
}