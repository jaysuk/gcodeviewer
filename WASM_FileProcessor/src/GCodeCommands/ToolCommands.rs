use crate::gcode_line::{GCodeLine, ToolCommand};
use crate::processor_properties::ProcessorProperties;
use crate::utils::{parse_number_fast, skip_whitespace};

/// Parse tool change commands (T0, T1, etc.) and related M-codes
pub fn parse_tool_command(
    properties: &mut ProcessorProperties,
    line: &str,
    file_position: u32,
    line_number: u32,
) -> Result<GCodeLine, String> {
    
    let line_bytes = line.as_bytes();
    let mut pos = 0;
    
    // Skip command prefix (T, M104, M109, etc.)
    while pos < line_bytes.len() && line_bytes[pos] != b' ' && line_bytes[pos] != b'\t' {
        pos += 1;
    }
    
    let command = &line[..pos];
    let mut tool_number: Option<u32> = None;
    let mut temperature: Option<f64> = None;
    let mut wait_for_temperature = false;
    
    // Parse tool number from T command (e.g., T0, T1). RepRapFirmware's `T-1` deselects all
    // tools - parsed as i32 first (not u32, which would reject the '-' entirely and drop the
    // command) and clamped to 0 for any negative index. Only clamping negatives, not upper-bound
    // checking against properties.tools.len(): Rust's default tool table has a single entry
    // (unlike the TypeScript parser's 5 pre-populated defaults), so an upper-bound clamp here
    // would incorrectly reject any ordinary T1+ selection.
    if command.starts_with('T') || command.starts_with('t') {
        if let Ok(parsed) = command[1..].parse::<i32>() {
            let clamped = if parsed < 0 { 0 } else { parsed };
            tool_number = Some(clamped as u32);
        }
    }
    
    // Parse parameters
    while pos < line_bytes.len() {
        pos = skip_whitespace(line_bytes, pos);
        
        if pos >= line_bytes.len() {
            break;
        }
        
        let param_char = line_bytes[pos] as char;
        pos += 1;
        
        match param_char {
            'T' | 't' => {
                // Tool parameter in M-code (e.g., M104 T1 S200)
                let parse_result = parse_number_fast(&line_bytes, pos).ok_or("Failed to parse number")?;
                let value = parse_result.value;
                let new_pos = pos + parse_result.consumed_bytes;
                tool_number = Some(value as u32);
                pos = new_pos;
            }
            'S' | 's' => {
                // Temperature parameter
                let parse_result = parse_number_fast(&line_bytes, pos).ok_or("Failed to parse number")?;
                let value = parse_result.value;
                let new_pos = pos + parse_result.consumed_bytes;
                temperature = Some(value);
                pos = new_pos;
            }
            'P' | 'p' => {
                // Some tool commands use P for tool number
                let parse_result = parse_number_fast(&line_bytes, pos).ok_or("Failed to parse number")?;
                let value = parse_result.value;
                let new_pos = pos + parse_result.consumed_bytes;
                if tool_number.is_none() {
                    tool_number = Some(value as u32);
                }
                pos = new_pos;
            }
            ';' => break, // Comment start
            _ => {
                // Skip unknown parameters
                while pos < line_bytes.len() && !line_bytes[pos].is_ascii_whitespace() {
                    pos += 1;
                }
            }
        }
    }
    
    // Determine command type
    let command_type = if command.starts_with('T') || command.starts_with('t') {
        "TOOL_CHANGE"
    } else if command == "M104" {
        "SET_HOTEND_TEMP"
    } else if command == "M109" {
        wait_for_temperature = true;
        "SET_HOTEND_TEMP_WAIT"
    } else if command == "M140" {
        "SET_BED_TEMP"
    } else if command == "M190" {
        wait_for_temperature = true;
        "SET_BED_TEMP_WAIT"
    } else if command == "M106" {
        "FAN_ON"
    } else if command == "M107" {
        "FAN_OFF"
    } else {
        "UNKNOWN_TOOL_COMMAND"
    };
    
    // Update processor state
    if let Some(tool_num) = tool_number {
        if command.starts_with('T') || command.starts_with('t') {
            properties.current_tool.tool_number = tool_num as u8;
        }
    }
    
    if let Some(temp) = temperature {
        if command == "M104" || command == "M109" {
            properties.target_hotend_temp = temp;
        } else if command == "M140" || command == "M190" {
            properties.target_bed_temp = temp;
        }
    }
    
    let tool_cmd = ToolCommand {
        command_type: command_type.to_string(),
        tool_number,
        temperature,
        wait_for_temperature,
        file_position,
        line_number,
        original_line: line.to_string(),
    };
    
    Ok(GCodeLine::Tool(tool_cmd))
}

/// Parse miscellaneous M-codes (M84, M28, etc.)
pub fn parse_m_command(
    properties: &mut ProcessorProperties,
    line: &str,
    file_position: u32,
    line_number: u32,
) -> Result<GCodeLine, String> {
    
    let line_bytes = line.as_bytes();
    let mut pos = 0;

    // Skip leading whitespace - the caller passes the original (untrimmed) line, not the
    // router's trimmed copy
    while pos < line_bytes.len() && (line_bytes[pos] == b' ' || line_bytes[pos] == b'\t') {
        pos += 1;
    }
    let command_start = pos;

    // Extract M-code number
    while pos < line_bytes.len() && line_bytes[pos] != b' ' && line_bytes[pos] != b'\t' {
        pos += 1;
    }

    // Uppercased so "m84"/indented "  M84" match the same M-code arms below as "M84" does -
    // matches TS's ProcessLine.ts, which uppercases and trims before routing (`workingLine`, the
    // fastGCodeRegex's `i` flag)
    let command_owned = line[command_start..pos].to_uppercase();
    let command = command_owned.as_str();
    let mut parameters = Vec::new();
    
    // Parse parameters
    while pos < line_bytes.len() {
        pos = skip_whitespace(line_bytes, pos);
        
        if pos >= line_bytes.len() {
            break;
        }
        
        let param_char = line_bytes[pos] as char;
        
        if param_char == ';' {
            break; // Comment start
        }
        
        pos += 1;
        
        if let Some(parse_result) = parse_number_fast(line.as_bytes(), pos) {
            let value = parse_result.value;
            let new_pos = pos + parse_result.consumed_bytes;
            parameters.push((param_char, value));
            pos = new_pos;
        } else {
            // Skip invalid parameter
            while pos < line_bytes.len() && !line_bytes[pos].is_ascii_whitespace() {
                pos += 1;
            }
        }
    }
    
    // Handle specific M-codes
    match command {
        "M84" => {
            // Disable steppers
            properties.steppers_enabled = false;
        }
        "M17" => {
            // Enable steppers  
            properties.steppers_enabled = true;
        }
        "M82" => {
            // Absolute extrusion mode
            properties.absolute_extrusion = true;
        }
        "M83" => {
            // Relative extrusion mode
            properties.absolute_extrusion = false;
        }
        "M92" => {
            // Set steps per unit - store for reference
            for (param, value) in &parameters {
                match param {
                    'X' | 'x' => properties.steps_per_mm_x = *value,
                    'Y' | 'y' => properties.steps_per_mm_y = *value,
                    'Z' | 'z' => properties.steps_per_mm_z = *value,
                    'E' | 'e' => properties.steps_per_mm_e = *value,
                    _ => {}
                }
            }
        }
        _ => {
            // Generic M-code handling
        }
    }
    
    let tool_cmd = ToolCommand {
        command_type: format!("M_COMMAND_{}", &command[1..]), // M84 -> M_COMMAND_84
        tool_number: None,
        temperature: parameters.iter().find(|(c, _)| *c == 'S').map(|(_, v)| *v),
        wait_for_temperature: false,
        file_position,
        line_number,
        original_line: line.to_string(),
    };
    
    Ok(GCodeLine::Tool(tool_cmd))
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_parse_tool_change() {
        let mut props = ProcessorProperties::new();
        
        let result = parse_tool_command(&mut props, "T1", 100, 1);
        assert!(result.is_ok());
        
        if let Ok(GCodeLine::Tool(tool_cmd)) = result {
            assert_eq!(tool_cmd.command_type, "TOOL_CHANGE");
            assert_eq!(tool_cmd.tool_number, Some(1));
            assert_eq!(props.current_tool.tool_number, 1);
        }
    }

    #[test]
    fn test_parse_tool_deselect_all() {
        // RepRapFirmware's T-1 deselects all tools - must not be dropped/ignored, and must not
        // reach the router as an unrecognized line (detect_gcode_command has to see it as a
        // T-command at all before parse_tool_command ever runs)
        use crate::GCodeCommands::ProcessLine::process_line;
        let mut props = ProcessorProperties::new();

        let result = process_line(&mut props, "T-1", 100, 1);
        assert!(result.is_ok());
        assert!(matches!(result.unwrap(), GCodeLine::Tool(_)));
        assert_eq!(props.current_tool.tool_number, 0);

        let result2 = parse_tool_command(&mut props, "T-1", 100, 1);
        if let Ok(GCodeLine::Tool(tool_cmd)) = result2 {
            assert_eq!(tool_cmd.tool_number, Some(0));
        } else {
            panic!("expected a Tool command for T-1");
        }
    }

    #[test]
    fn test_parse_hotend_temp() {
        let mut props = ProcessorProperties::new();
        
        let result = parse_tool_command(&mut props, "M104 S200", 200, 2);
        assert!(result.is_ok());
        
        if let Ok(GCodeLine::Tool(tool_cmd)) = result {
            assert_eq!(tool_cmd.command_type, "SET_HOTEND_TEMP");
            assert_eq!(tool_cmd.temperature, Some(200.0));
            assert_eq!(props.target_hotend_temp, 200.0);
            assert!(!tool_cmd.wait_for_temperature);
        }
    }
    
    #[test]
    fn test_parse_bed_temp_wait() {
        let mut props = ProcessorProperties::new();
        
        let result = parse_tool_command(&mut props, "M190 S60", 300, 3);
        assert!(result.is_ok());
        
        if let Ok(GCodeLine::Tool(tool_cmd)) = result {
            assert_eq!(tool_cmd.command_type, "SET_BED_TEMP_WAIT");
            assert_eq!(tool_cmd.temperature, Some(60.0));
            assert_eq!(props.target_bed_temp, 60.0);
            assert!(tool_cmd.wait_for_temperature);
        }
    }
    
    #[test]
    fn test_parse_m84_disable_steppers() {
        let mut props = ProcessorProperties::new();
        props.steppers_enabled = true;

        let result = parse_m_command(&mut props, "M84", 400, 4);
        assert!(result.is_ok());
        assert!(!props.steppers_enabled);
    }

    #[test]
    fn test_parse_m_command_lowercase_and_indented() {
        // The router (ProcessLine.rs) passes the original, untrimmed line - a leading-whitespace
        // or lowercase M-code previously failed the exact string match against "M84" silently
        let mut props = ProcessorProperties::new();
        props.steppers_enabled = true;
        let result = parse_m_command(&mut props, "  m84", 400, 4);
        assert!(result.is_ok());
        assert!(!props.steppers_enabled, "lowercase/indented m84 should still disable steppers");
    }
}