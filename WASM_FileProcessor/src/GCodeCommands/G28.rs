use crate::gcode_line::{GCodeLine, CommandData};
use crate::processor_properties::ProcessorProperties;
use crate::utils::{parse_number_fast, skip_whitespace};

/// Parse G28 (Auto Home) command
/// G28: Home all axes, or specific axes if parameters provided
/// Format: G28 [X] [Y] [Z] [E]
pub fn parse_g28_home(
    properties: &mut ProcessorProperties,
    line: &str,
    file_position: u32,
    line_number: u32,
) -> Result<GCodeLine, String> {
    
    let line_bytes = line.as_bytes();
    let mut pos = 0;
    
    // Skip G28 command
    while pos < line_bytes.len() && line_bytes[pos] != b' ' && line_bytes[pos] != b'\t' {
        pos += 1;
    }
    
    let mut home_x = false;
    let mut home_y = false;
    let mut home_z = false;
    let mut home_e = false;
    let mut parameters = Vec::new();
    
    // If no parameters specified, home all axes
    let mut has_parameters = false;
    
    // Parse parameters to determine which axes to home
    while pos < line_bytes.len() {
        pos = skip_whitespace(line_bytes, pos);
        
        if pos >= line_bytes.len() {
            break;
        }
        
        let param_char = line_bytes[pos] as char;
        pos += 1;
        has_parameters = true;
        
        match param_char {
            'X' | 'x' => {
                home_x = true;
                parameters.push(("X".to_string(), 0.0));
            }
            'Y' | 'y' => {
                home_y = true;
                parameters.push(("Y".to_string(), 0.0));
            }
            'Z' | 'z' => {
                home_z = true;
                parameters.push(("Z".to_string(), 0.0));
            }
            'E' | 'e' => {
                home_e = true;
                parameters.push(("E".to_string(), 0.0));
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
    
    // If no specific axes mentioned, home all axes
    if !has_parameters {
        home_x = true;
        home_y = true;
        home_z = true;
        home_e = true;
        parameters.push(("X".to_string(), 0.0));
        parameters.push(("Y".to_string(), 0.0));
        parameters.push(("Z".to_string(), 0.0));
        parameters.push(("E".to_string(), 0.0));
    }
    let _ = (home_x, home_y, home_z, home_e); // kept for the informational `parameters` list below

    // Does NOT reset current_position/current_e - matches TS's g28.ts exactly, which parses G28
    // into a plain Command with no state changes at all. An earlier version of this port zeroed
    // out whichever axes were named, which the TS reference implementation never did (the actual
    // physical home position isn't 0,0,0 in machine/workplace-offset terms anyway).

    // Create command data
    let mut cmd_data = CommandData::new(file_position, line_number, line.to_string(), "G28".to_string());
    cmd_data.parameters = parameters;
    
    Ok(GCodeLine::Command(cmd_data))
}

/// Parse G29 (Bed Leveling) command
pub fn parse_g29_bed_leveling(
    _properties: &mut ProcessorProperties,
    line: &str,
    file_position: u32,
    line_number: u32,
) -> Result<GCodeLine, String> {
    
    // G29 just triggers bed leveling - no state changes needed
    let cmd_data = CommandData::new(file_position, line_number, line.to_string(), "G29".to_string());
    Ok(GCodeLine::Command(cmd_data))
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_parse_g28_does_not_move_position() {
        // Matches TS's g28.ts exactly - G28 parses into a plain Command, current_position and
        // current_e are left completely untouched (the physical home position isn't 0,0,0 in
        // machine/workplace-offset terms anyway, so zeroing it out was never correct).
        let mut props = ProcessorProperties::new();
        props.current_position.x = 100.0;
        props.current_position.y = 50.0;
        props.current_position.z = 10.0;
        props.current_e = 5.0;

        let result = parse_g28_home(&mut props, "G28", 100, 1);
        assert!(result.is_ok());

        assert_eq!(props.current_position.x, 100.0);
        assert_eq!(props.current_position.y, 50.0);
        assert_eq!(props.current_position.z, 10.0);
        assert_eq!(props.current_e, 5.0);

        if let Ok(GCodeLine::Command(cmd)) = result {
            assert_eq!(cmd.command_type, "G28");
        }
    }

    #[test]
    fn test_parse_g28_with_axis_params_still_does_not_move_position() {
        let mut props = ProcessorProperties::new();
        props.current_position.x = 100.0;
        props.current_position.y = 50.0;
        props.current_position.z = 10.0;

        let result = parse_g28_home(&mut props, "G28 X Z", 200, 2);
        assert!(result.is_ok());

        assert_eq!(props.current_position.x, 100.0);
        assert_eq!(props.current_position.y, 50.0);
        assert_eq!(props.current_position.z, 10.0);
    }
}