use crate::gcode_line::{GCodeLine, CommandData, MCodeData};
use crate::processor_properties::{ProcessorProperties, WorkplaceOffset};

/// Parse workplace coordinate system commands (G54-G59.3)
/// G54-G59: Select coordinate system 1-6
/// G59.1-G59.3: Extended coordinate systems 7-9
pub fn parse_workplace_coordinates(
    properties: &mut ProcessorProperties,
    line: &str,
    command: &str,
    file_position: u32,
    line_number: u32,
) -> Result<GCodeLine, String> {
    
    // Map G-code command to workspace index
    let workspace_idx = match command {
        "G54" => 0,
        "G55" => 1,
        "G56" => 2,
        "G57" => 3,
        "G58" => 4,
        "G59" => 5,
        "G59.1" => 6,
        "G59.2" => 7,
        "G59.3" => 8,
        _ => return Err(format!("Unknown workplace command: {}", command)),
    };
    
    // G59.1-G59.3 (indices 6-8) exceed the 6 slots ProcessorProperties::new() pre-allocates for
    // G54-G59 - grow the table rather than silently dropping the switch, matching the TypeScript
    // parser's workplace.ts (which pushes new Vector3(0,0,0) entries until the index fits)
    while properties.workplace_offsets.len() <= workspace_idx {
        let next_idx = properties.workplace_offsets.len() as u8;
        properties.workplace_offsets.push(WorkplaceOffset::new(next_idx));
    }
    properties.current_workplace_idx = workspace_idx as u8;
    
    // Create command data
    let cmd_data = CommandData::new(
        file_position, 
        line_number, 
        line.to_string(), 
        command.to_string()
    );
    Ok(GCodeLine::Command(cmd_data))
}

/// Parse M3/M4 (Spindle Control) commands
/// M3: Spindle clockwise
/// M4: Spindle counter-clockwise
pub fn parse_m3_m4_spindle(
    properties: &mut ProcessorProperties,
    line: &str,
    command: &str,
    file_position: u32,
    line_number: u32,
) -> Result<GCodeLine, String> {
    
    // For CNC mode, this affects spindle state
    if properties.cnc_mode {
        // Could track spindle state here if needed
        // properties.spindle_on = true;
        // properties.spindle_clockwise = command == "M3";
    }
    
    let mcode_num = match command {
        "M3" => 3,
        "M4" => 4,
        _ => return Err(format!("Invalid spindle command: {}", command)),
    };
    
    // Create M-code data
    let mcode_data = MCodeData::new(file_position, line_number, line.to_string(), mcode_num);
    Ok(GCodeLine::MCode(mcode_data))
}

/// Parse M5 (Spindle Stop) command
pub fn parse_m5_spindle_stop(
    properties: &mut ProcessorProperties,
    line: &str,
    file_position: u32,
    line_number: u32,
) -> Result<GCodeLine, String> {
    
    // For CNC mode, stop spindle
    if properties.cnc_mode {
        // Could track spindle state here if needed
        // properties.spindle_on = false;
    }
    
    // Create M-code data
    let mcode_data = MCodeData::new(file_position, line_number, line.to_string(), 5);
    Ok(GCodeLine::MCode(mcode_data))
}

/// Parse M567 (Set Mixing Ratios) command
/// Used for mixing hotends to set extruder ratios
pub fn parse_m567_mixing(
    properties: &mut ProcessorProperties,
    line: &str,
    file_position: u32,
    line_number: u32,
) -> Result<GCodeLine, String> {
    
    // Enable mixing mode
    properties.has_mixing = true;
    
    // Create M-code data
    let mut mcode_data = MCodeData::new(file_position, line_number, line.to_string(), 567);
    
    // TODO: Parse mixing ratios from parameters if needed
    // This would require parsing E0, E1, E2, etc. parameters
    
    Ok(GCodeLine::MCode(mcode_data))
}

/// Parse M600 (Filament Change) command
/// Pause print for manual filament change
pub fn parse_m600_filament_change(
    _properties: &mut ProcessorProperties,
    line: &str,
    file_position: u32,
    line_number: u32,
) -> Result<GCodeLine, String> {
    
    // M600 typically pauses the print for filament change
    // No specific state changes needed in processor
    
    // Create M-code data
    let mcode_data = MCodeData::new(file_position, line_number, line.to_string(), 600);
    Ok(GCodeLine::MCode(mcode_data))
}

/// Parse blank/empty lines (utility function)
pub fn parse_blank_line(
    _properties: &mut ProcessorProperties,
    line: &str,
    file_position: u32,
    line_number: u32,
) -> Result<GCodeLine, String> {
    
    // Empty lines are treated as comments
    Ok(GCodeLine::new_comment(file_position, line_number, line.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_parse_workplace_g54() {
        let mut props = ProcessorProperties::new();
        props.current_workplace_idx = 1; // Start at G55
        
        let result = parse_workplace_coordinates(&mut props, "G54", "G54", 100, 1);
        assert!(result.is_ok());
        assert_eq!(props.current_workplace_idx, 0); // Should switch to G54 (index 0)
    }
    
    #[test]
    fn test_parse_workplace_g59_3() {
        let mut props = ProcessorProperties::new();
        
        let result = parse_workplace_coordinates(&mut props, "G59.3", "G59.3", 200, 2);
        assert!(result.is_ok());
        assert_eq!(props.current_workplace_idx, 8); // G59.3 is index 8
    }
    
    #[test]
    fn test_parse_m3_spindle() {
        let mut props = ProcessorProperties::new();
        props.cnc_mode = true;
        
        let result = parse_m3_m4_spindle(&mut props, "M3 S1000", "M3", 300, 3);
        assert!(result.is_ok());
        
        if let Ok(GCodeLine::MCode(mcode)) = result {
            assert_eq!(mcode.mcode_number, 3);
        }
    }
    
    #[test]
    fn test_parse_m600_filament_change() {
        let mut props = ProcessorProperties::new();
        
        let result = parse_m600_filament_change(&mut props, "M600", 400, 4);
        assert!(result.is_ok());
        
        if let Ok(GCodeLine::MCode(mcode)) = result {
            assert_eq!(mcode.mcode_number, 600);
        }
    }
    
    #[test]
    fn test_parse_m567_mixing() {
        let mut props = ProcessorProperties::new();
        props.has_mixing = false;
        
        let result = parse_m567_mixing(&mut props, "M567 E0.5:0.5", 500, 5);
        assert!(result.is_ok());
        assert!(props.has_mixing); // Should enable mixing
        
        if let Ok(GCodeLine::MCode(mcode)) = result {
            assert_eq!(mcode.mcode_number, 567);
        }
    }
}