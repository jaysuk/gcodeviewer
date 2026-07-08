use crate::gcode_line::{GCodeLine, CommentData, CommandData, MCodeData};
use crate::processor_properties::ProcessorProperties;
use crate::utils::{is_comment_line, detect_gcode_command, parse_parameter};
use crate::GCodeCommands::G0G1::{parse_g0_g1_move, is_g0_g1_command};
use crate::GCodeCommands::G2G3::parse_arc_move;
use crate::GCodeCommands::G28::{parse_g28_home, parse_g29_bed_leveling};
use crate::GCodeCommands::G90G91::{parse_g90_absolute, parse_g91_relative};
use crate::GCodeCommands::G20G21::{parse_g20_inches, parse_g21_millimeters};
use crate::GCodeCommands::G10G11::{parse_g10_retract, parse_g11_unretract};
use crate::GCodeCommands::ToolCommands::{parse_tool_command, parse_m_command};
use crate::GCodeCommands::MiscCommands::{parse_workplace_coordinates, parse_m3_m4_spindle, parse_m5_spindle_stop, parse_m567_mixing, parse_m600_filament_change};

/// Main line processing function - routes lines to appropriate specialized parsers
/// This is the entry point for processing each G-code line
pub fn process_line(
    props: &mut ProcessorProperties,
    line: &str,
    file_position: u32,
    line_number: u32,
) -> Result<GCodeLine, String> {
    
    let trimmed_line = line.trim();
    
    // Fast path for empty lines and comments (most common after moves)
    if is_comment_line(trimmed_line) {
        return Ok(GCodeLine::Comment(CommentData::new(
            file_position,
            line_number,
            line.to_string(),
        )));
    }
    
    // Ultra-fast path for G0/G1 moves (80%+ of lines in most files)
    if is_g0_g1_command(trimmed_line) {
        return parse_g0_g1_move(props, line, file_position, line_number);
    }
    
    // Detect other G-code commands
    if let Some(command) = detect_gcode_command(trimmed_line) {
        let command_upper = command.to_uppercase();
        
        match command_upper.as_str() {
            // Positioning modes
            "G90" => {
                return parse_g90_absolute(props, line, file_position, line_number);
            }
            "G91" => {
                return parse_g91_relative(props, line, file_position, line_number);
            }
            
            // Units
            "G20" => {
                return parse_g20_inches(props, line, file_position, line_number);
            }
            "G21" => {
                return parse_g21_millimeters(props, line, file_position, line_number);
            }
            
            // Retraction
            "G10" => {
                return parse_g10_retract(props, line, file_position, line_number);
            }
            "G11" => {
                return parse_g11_unretract(props, line, file_position, line_number);
            }
            
            // Workplace coordinates
            "G54" | "G55" | "G56" | "G57" | "G58" | "G59" => {
                return parse_workplace_coordinates(props, line, &command_upper, file_position, line_number);
            }
            "G59.1" | "G59.2" | "G59.3" => {
                return parse_workplace_coordinates(props, line, &command_upper, file_position, line_number);
            }
            
            // G2/G3 Arc moves
            "G2" | "G02" => {
                return parse_arc_move(props, line, true, file_position, line_number);
            }
            "G3" | "G03" => {
                return parse_arc_move(props, line, false, file_position, line_number);
            }
            
            // G28 Home
            "G28" => {
                return parse_g28_home(props, line, file_position, line_number);
            }
            
            // G29 Bed Leveling  
            "G29" => {
                return parse_g29_bed_leveling(props, line, file_position, line_number);
            }
            
            // M-codes - route to appropriate parsers
            _ if command_upper.starts_with('M') => {
                let mcode_num = command_upper[1..].parse::<u32>().unwrap_or(0);
                match mcode_num {
                    // Temperature and tool-related M-codes
                    104 | 109 | 140 | 190 | 106 | 107 => {
                        return parse_tool_command(props, line, file_position, line_number);
                    }
                    // Spindle control
                    3 => {
                        return parse_m3_m4_spindle(props, line, "M3", file_position, line_number);
                    }
                    4 => {
                        return parse_m3_m4_spindle(props, line, "M4", file_position, line_number);
                    }
                    5 => {
                        return parse_m5_spindle_stop(props, line, file_position, line_number);
                    }
                    // Mixing extruder
                    567 => {
                        return parse_m567_mixing(props, line, file_position, line_number);
                    }
                    // Filament change
                    600 => {
                        return parse_m600_filament_change(props, line, file_position, line_number);
                    }
                    // Other M-codes
                    _ => {
                        return parse_m_command(props, line, file_position, line_number);
                    }
                }
            }
            
            // T-codes (tool changes)
            _ if command_upper.starts_with('T') => {
                return parse_tool_command(props, line, file_position, line_number);
            }
            
            // Other G-codes
            _ => {
                return Ok(create_command(file_position, line_number, line, command_upper));
            }
        }
    }
    
    // If we get here, it's likely a comment or unrecognized line
    Ok(GCodeLine::Comment(CommentData::new(
        file_position,
        line_number,
        line.to_string(),
    )))
}

/// Create a generic command object
fn create_command(
    file_position: u32,
    line_number: u32,
    line: &str,
    command_type: String,
) -> GCodeLine {
    let mut cmd_data = CommandData::new(file_position, line_number, line.to_string(), command_type);
    
    // Parse any parameters
    let bytes = line.as_bytes();
    let mut i = 0;
    
    while i < bytes.len() {
        if let Some((letter, value, consumed)) = parse_parameter(bytes, i) {
            cmd_data.parameters.push((letter.to_string(), value));
            i += consumed;
        } else {
            i += 1;
        }
    }
    
    GCodeLine::Command(cmd_data)
}

/// Fast line type detection without full parsing
pub fn detect_line_type(line: &str) -> LineType {
    let trimmed = line.trim();
    
    if is_comment_line(trimmed) {
        LineType::Comment
    } else if is_g0_g1_command(trimmed) {
        LineType::Move
    } else if let Some(command) = detect_gcode_command(trimmed) {
        let upper = command.to_uppercase();
        if upper.starts_with('M') {
            LineType::MCode
        } else if upper.starts_with('G') {
            match upper.as_str() {
                "G2" | "G02" | "G3" | "G03" => LineType::Arc,
                _ => LineType::Command,
            }
        } else {
            LineType::Command
        }
    } else {
        LineType::Comment
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LineType {
    Move,
    Arc,
    Comment,
    Command,
    MCode,
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_process_line_comments() {
        let mut props = ProcessorProperties::new();
        
        // Test comment line
        let result = process_line(&mut props, "; This is a comment", 0, 1);
        assert!(result.is_ok());
        assert!(matches!(result.unwrap(), GCodeLine::Comment(_)));
        
        // Test empty line
        let result = process_line(&mut props, "   ", 10, 2);
        assert!(result.is_ok());
        assert!(matches!(result.unwrap(), GCodeLine::Comment(_)));
    }
    
    #[test]
    fn test_process_line_moves() {
        let mut props = ProcessorProperties::new();
        
        // Test G0 move
        let result = process_line(&mut props, "G0 X10 Y20", 20, 3);
        assert!(result.is_ok());
        assert!(matches!(result.unwrap(), GCodeLine::Move(_)));
        
        // Test G1 move
        let result = process_line(&mut props, "G1 X15 Y25 E0.1", 50, 4);
        assert!(result.is_ok());
        assert!(matches!(result.unwrap(), GCodeLine::Move(_)));
    }
    
    #[test]
    fn test_process_line_commands() {
        let mut props = ProcessorProperties::new();
        
        // Test G90 command
        let result = process_line(&mut props, "G90", 100, 5);
        assert!(result.is_ok());
        assert!(matches!(result.unwrap(), GCodeLine::Command(_)));
        assert!(props.absolute_positioning);
        
        // Test G91 command
        let result = process_line(&mut props, "G91", 110, 6);
        assert!(result.is_ok());
        assert!(matches!(result.unwrap(), GCodeLine::Command(_)));
        assert!(!props.absolute_positioning);
    }
    
    #[test]
    fn test_process_line_mcodes() {
        let mut props = ProcessorProperties::new();
        
        // Test M104 command
        let result = process_line(&mut props, "M104 S200", 200, 7);
        assert!(result.is_ok());
        if let Ok(GCodeLine::MCode(mcode)) = result {
            assert_eq!(mcode.mcode_number, 104);
            assert_eq!(props.current_tool.temperature, 200.0);
        }
    }
    
    #[test]
    fn test_detect_line_type() {
        assert_eq!(detect_line_type("; comment"), LineType::Comment);
        assert_eq!(detect_line_type("G0 X10"), LineType::Move);
        assert_eq!(detect_line_type("G1 Y20"), LineType::Move);
        assert_eq!(detect_line_type("G90"), LineType::Command);
        assert_eq!(detect_line_type("M104 S200"), LineType::MCode);
        assert_eq!(detect_line_type("G2 X10 Y20"), LineType::Arc);
    }
}