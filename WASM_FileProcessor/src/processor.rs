use crate::gcode_line::{GCodeLine, GCodeLineBase};
use crate::processor_properties::ProcessorProperties;
use crate::GCodeCommands::ProcessLine::process_line;
use crate::slicers::detect_slicer;
use crate::{call_progress, PositionData, ProgressCallback};
use std::collections::HashMap;
use wasm_bindgen::prelude::*;

// Sentinel error string signaling a user-requested cancellation (via the progress callback
// returning true) rather than a genuine parse failure - GCodeProcessor::process_file (lib.rs)
// checks for this exact string to set ProcessingResult.cancelled instead of reporting an error.
pub(crate) const CANCELLED_ERROR: &str = "CANCELLED";

// Console logging for WASM - the extern binds to a real console.log only inside a wasm host;
// `cargo test` runs natively (x86_64), where calling it panics with "cannot call wasm-bindgen
// imported functions on non-wasm targets" and previously made every test that exercises this
// logging untestable outside a browser. Falls back to println! on non-wasm targets instead.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

#[cfg(not(target_arch = "wasm32"))]
fn log(s: &str) {
    println!("{}", s);
}

macro_rules! console_log {
    ($($t:tt)*) => (log(&format_args!($($t)*).to_string()))
}

/// Splits on '\n' only, keeping any preceding '\r' as part of the returned line - matching the
/// TypeScript parser's streamLines(). str::lines() strips both '\r' and '\n', which undercounts
/// each CRLF line's consumed bytes by one, drifting file_position out of sync with the
/// TypeScript-parsed gCodeLines used for picking/scrubbing on Windows-authored G-code.
fn split_lines_keep_cr(content: &str) -> Vec<&str> {
    let mut lines = Vec::new();
    let bytes = content.as_bytes();
    let mut start = 0usize;
    for i in 0..bytes.len() {
        if bytes[i] == b'\n' {
            lines.push(&content[start..i]);
            start = i + 1;
        }
    }
    if start < content.len() {
        lines.push(&content[start..]);
    }
    lines
}

/// High-performance file processor optimized for WASM
pub struct FileProcessor {
    properties: ProcessorProperties,
    // Settings pushed in from the consumer (e.g. DWC's live-synced belt/workplace/CNC state) -
    // these previously never reached the WASM parser at all (it only ever saw raw file text), so
    // belt printers and custom workplace offsets silently parsed with the wrong kinematics when
    // WASM was enabled. Stored here (not directly on ProcessorProperties) so they survive
    // properties.reset() and are re-applied at the start of every process_file_content call,
    // mirroring the TS Processor's own "sticky pending settings" pattern
    // (applyZBelt/applyPendingWorkplace in src/processor.ts).
    pending_z_belt: Option<(bool, f64)>,
    pending_workplace_offsets: Option<Vec<crate::gcode_line::Vector3>>,
    pending_workplace_index: Option<u8>,
    pending_cnc_mode: Option<bool>,
    pending_fix_radius: Option<bool>,
    pending_arc_plane: Option<crate::processor_properties::ArcPlane>,
}

impl FileProcessor {
    pub fn new() -> Self {
        Self {
            properties: ProcessorProperties::new(),
            pending_z_belt: None,
            pending_workplace_offsets: None,
            pending_workplace_index: None,
            pending_cnc_mode: None,
            pending_fix_radius: None,
            pending_arc_plane: None,
        }
    }

    pub fn set_z_belt(&mut self, enabled: bool, gantry_angle_degrees: f64) {
        self.pending_z_belt = Some((enabled, gantry_angle_degrees));
        self.apply_pending_settings();
    }

    pub fn set_workplace_offsets(&mut self, offsets: Vec<crate::gcode_line::Vector3>) {
        self.pending_workplace_offsets = Some(offsets);
        self.apply_pending_settings();
    }

    pub fn set_current_workplace_index(&mut self, index: u8) {
        self.pending_workplace_index = Some(index);
        self.apply_pending_settings();
    }

    pub fn set_cnc_mode(&mut self, enabled: bool) {
        self.pending_cnc_mode = Some(enabled);
        self.apply_pending_settings();
    }

    pub fn set_fix_radius(&mut self, enabled: bool) {
        self.pending_fix_radius = Some(enabled);
        self.apply_pending_settings();
    }

    pub fn set_arc_plane(&mut self, plane: crate::processor_properties::ArcPlane) {
        self.pending_arc_plane = Some(plane);
        self.apply_pending_settings();
    }

    // Applies every pending setting onto the live ProcessorProperties - called both immediately
    // (so a setting takes effect without waiting for the next load) and again at the start of
    // process_file_content (since reset() would otherwise wipe them back to defaults)
    fn apply_pending_settings(&mut self) {
        if let Some((enabled, angle)) = self.pending_z_belt {
            self.properties.z_belt = enabled;
            self.properties.set_gantry_angle(angle);
        }
        if let Some(ref offsets) = self.pending_workplace_offsets {
            self.properties.workplace_offsets = offsets
                .iter()
                .enumerate()
                .map(|(idx, offset)| crate::processor_properties::WorkplaceOffset {
                    index: idx as u8,
                    offset: offset.clone(),
                    name: format!("G5{}", idx + 4),
                })
                .collect();
        }
        if let Some(index) = self.pending_workplace_index {
            self.properties.current_workplace_idx = index;
        }
        if let Some(enabled) = self.pending_cnc_mode {
            self.properties.cnc_mode = enabled;
        }
        if let Some(enabled) = self.pending_fix_radius {
            self.properties.fix_radius = enabled;
        }
        if let Some(ref plane) = self.pending_arc_plane {
            self.properties.arc_plane = plane.clone();
        }
    }

    /// Process G-code file content and return parsed lines and position data
    /// Returns (gcode_lines, position_tracker)
    pub fn process_file_content(
        &mut self,
        file_content: &str,
        progress_callback: Option<ProgressCallback>,
    ) -> Result<(Vec<GCodeLine>, HashMap<u32, PositionData>), String> {

        // Reset processor state for new file
        self.properties.reset();
        // reset() zeroes current_workplace_idx (and, defensively against future reset() changes,
        // this also re-applies zBelt/cncMode/fixRadius/arcPlane/workplace_offsets, none of which
        // reset() currently touches but shouldn't be assumed to stay that way)
        self.apply_pending_settings();

        // Detect slicer type. Feature-coloring state (color/perimeter/support) starts at the
        // SlicerBase defaults set by reset() above (white/true/false, matching TS exactly) until
        // the first `;TYPE:` comment updates it - no explicit seeding needed here.
        let mut slicer = detect_slicer(file_content);
        self.properties.slicer_name = slicer.get_name().to_string();

        // Estimate processing parameters
        let file_length = file_content.len();
        let estimated_lines = file_length / 40; // Average ~40 chars per line
        let chunk_size = (10000.min(estimated_lines / 10)).max(1); // Process in chunks; must never be 0 or the modulo below panics on tiny files
        
        console_log!("Processing {} bytes, estimated {} lines in chunks of {}", 
                    file_length, estimated_lines, chunk_size);
        
        // Pre-allocate result vectors with estimated capacity
        let mut gcode_lines = Vec::with_capacity(estimated_lines + estimated_lines / 5); // +20% buffer
        let mut position_tracker = HashMap::with_capacity(estimated_lines * 7 / 10); // ~70% moves
        
        // Stream through file line by line for optimal memory usage
        let mut file_position = 0u32;
        let mut line_number = 1u32;
        let mut lines_processed = 0usize;
        let mut last_progress_report = 0f64;
        
        // Process lines in chunks to avoid blocking
        for line in split_lines_keep_cr(file_content) {
            // Update position tracking
            self.properties.file_position = file_position;
            self.properties.line_number = line_number;
            
            // Process slicer comments for feature detection (before G-code processing)
            if line.trim().starts_with(";TYPE:") {
                // Pass trimmed comment to slicer to ensure consistent matching
                self.process_feature_comment(slicer.as_mut(), line.trim());
            }
            
            // Process the line2
            match process_line(&mut self.properties, line, file_position, line_number) {
                Ok(gcode_line) => {
                    // Store position data for both extruding and travel moves
                    if let Some(move_data) = gcode_line.as_move() {
                        if move_data.end.x.is_finite() && 
                           move_data.end.y.is_finite() && move_data.end.z.is_finite() &&
                           move_data.start.x.is_finite() && move_data.start.y.is_finite() && move_data.start.z.is_finite() {
                            
                            let pos_data = PositionData::new_with_color(
                                move_data.start.x, move_data.start.y, move_data.start.z,
                                move_data.end.x, move_data.end.y, move_data.end.z,
                                move_data.feed_rate,
                                move_data.extruding,
                                move_data.layer_height,
                                move_data.is_perimeter,
                                move_data.color.clone(),
                                line_number,
                                file_position,
                                (file_position + line.len() as u32),
                                move_data.tool as u32,
                                move_data.is_support,
                            );
                            
                            position_tracker.insert(file_position, pos_data);
                        }
                    } else if let Some(arc) = gcode_line.as_arc() {
                        // Segments were already tessellated in parse_arc_move (G2G3.rs) - no need
                        // to re-tessellate here. Only extruding arcs get position-tracked/rendered,
                        // matching G0/G1's own handling and TS's testRenderSceneProgressive filter.
                        if arc.extruding && !arc.segments.is_empty() {
                            // Every segment needs its own key in position_tracker, but the map is
                            // keyed by file byte offset - a naive "file_position + seg_index" scheme
                            // would collide with (and silently discard) whichever later line's real
                            // file_position it reached once a long arc produced more segments than
                            // the line was bytes long. Distribute segments proportionally across
                            // this line's own byte span instead, which can never reach the next
                            // line's file_position.
                            let total_segments = arc.segments.len() as u32;
                            let safe_span = (line.len() as u32).max(1);
                            for (idx, seg) in arc.segments.iter().enumerate() {
                                let seg_index = idx as u32;
                                let offset = if total_segments <= 1 {
                                    0
                                } else {
                                    seg_index * (safe_span - 1) / (total_segments - 1)
                                };
                                let pos_key = file_position + offset;
                                let pd = PositionData::new_with_color(
                                    seg.start.x, seg.start.y, seg.start.z,
                                    seg.end.x, seg.end.y, seg.end.z,
                                    seg.feed_rate,
                                    seg.extruding,
                                    seg.layer_height,
                                    seg.is_perimeter,
                                    seg.color.clone(),
                                    line_number,
                                    file_position,
                                    file_position + line.len() as u32,
                                    seg.tool as u32,
                                    seg.is_support,
                                );
                                position_tracker.insert(pos_key, pd);
                            }
                        }
                    }
                    
                    gcode_lines.push(gcode_line);
                }
                Err(error) => {
                    console_log!("Warning: Failed to parse line {}: {} ({})", line_number, error, line);
                    // Create a comment for unparseable lines
                    gcode_lines.push(GCodeLine::new_comment(file_position, line_number, line.to_string()));
                }
            }
            
            // Update position for next line (account for stripped newline)
            file_position += line.len() as u32 + 1;
            line_number += 1;
            lines_processed += 1;
            
            // Report progress every chunk or 2%
            if lines_processed % chunk_size == 0 || lines_processed % (estimated_lines / 50).max(1000) == 0 {
                let progress = lines_processed as f64 / estimated_lines as f64;
                
                // Only report if progress changed significantly (reduces callback overhead)
                if progress - last_progress_report >= 0.02 {
                    if let Some(ref callback) = progress_callback {
                        if call_progress(callback, progress.min(1.0), "Processing G-code") {
                            return Err(CANCELLED_ERROR.to_string());
                        }
                    }
                    last_progress_report = progress;
                }
            }
        }

        // Final progress report
        if let Some(ref callback) = progress_callback {
            call_progress(callback, 1.0, "Processing complete");
        }

        // Update final statistics
        self.properties.line_count = line_number - 1;
        
        console_log!("Processing complete: {} lines, {} moves, {} comments", 
                    gcode_lines.len(), 
                    position_tracker.len(),
                    gcode_lines.iter().filter(|l| matches!(l, GCodeLine::Comment(_))).count());
        
        Ok((gcode_lines, position_tracker))
    }
    
    /// Get processing statistics
    pub fn get_statistics(&self) -> ProcessorStatistics {
        ProcessorStatistics {
            line_count: self.properties.line_count,
            max_height: self.properties.max_height,
            min_height: self.properties.min_height,
            max_feed_rate: self.properties.max_feed_rate,
            min_feed_rate: self.properties.min_feed_rate,
            total_segments: self.properties.total_rendered_segments,
            slicer_name: self.properties.slicer_name.clone(),
            first_gcode_byte: self.properties.first_gcode_byte,
            last_gcode_byte: self.properties.last_gcode_byte,
            print_bounds_min_x: self.properties.print_bounds_min_x,
            print_bounds_min_y: self.properties.print_bounds_min_y,
            print_bounds_min_z: self.properties.print_bounds_min_z,
            print_bounds_max_x: self.properties.print_bounds_max_x,
            print_bounds_max_y: self.properties.print_bounds_max_y,
            print_bounds_max_z: self.properties.print_bounds_max_z,
        }
    }
    
    /// Validate file content before processing
    pub fn validate_file_content(file_content: &str) -> Result<(), String> {
        if file_content.is_empty() {
            return Err("File is empty".to_string());
        }
        
        if file_content.len() > 500_000_000 { // 500MB limit
            return Err("File too large (>500MB)".to_string());
        }
        
        // Check if it looks like G-code
        let lines: Vec<&str> = file_content.lines().take(100).collect();
        let mut gcode_lines = 0;
        let mut comment_lines = 0;
        
        for line in &lines {
            let trimmed = line.trim();
            if trimmed.starts_with(';') || trimmed.is_empty() {
                comment_lines += 1;
            } else {
                // A command letter must be followed by a digit (G0, M104, T0, ...) or, for T-codes
                // only, a negative number (RepRapFirmware's `T-1` deselects all tools) - matching
                // on the bare letter alone false-positives on ordinary English words ("This", "To",
                // "My", ...), which let arbitrary prose text pass validation as "looks like G-code"
                let mut chars = trimmed.chars();
                let first = chars.next();
                let second = chars.next();
                let is_command = match (first, second) {
                    (Some('G') | Some('M'), Some(c)) => c.is_ascii_digit(),
                    (Some('T'), Some(c)) => c.is_ascii_digit() || (c == '-' && chars.next().is_some_and(|c2| c2.is_ascii_digit())),
                    _ => false,
                };
                if is_command {
                    gcode_lines += 1;
                }
            }
        }
        
        if gcode_lines == 0 && comment_lines < lines.len() / 2 {
            return Err("File does not appear to contain valid G-code".to_string());
        }
        
        Ok(())
    }
    
    /// Process slicer feature comments to update coloring state. A single stateful
    /// `process_comment` call (mirroring TS's SlicerBase.processComment) replaces what used to be
    /// three separate re-parses of the same comment (parse_feature_from_comment,
    /// is_perimeter_comment, is_support_comment each independently matched the string again).
    fn process_feature_comment(&mut self, slicer: &mut dyn crate::slicers::slicer_base::SlicerBase, line: &str) {
        slicer.process_comment(line);
        self.properties.current_feature_color = slicer.get_feature_color();
        self.properties.current_is_perimeter = slicer.is_perimeter();
        self.properties.current_is_support = slicer.is_support();
    }
}

/// Processing statistics
#[derive(Debug, Clone)]
pub struct ProcessorStatistics {
    pub line_count: u32,
    pub max_height: f64,
    pub min_height: f64,
    pub max_feed_rate: f64,
    pub min_feed_rate: f64,
    pub total_segments: u32,
    pub slicer_name: String,
    pub first_gcode_byte: u32,
    pub last_gcode_byte: u32,
    // Bounding box (Babylon space: x, y=height, z) over extruding moves - null/infinite sentinels
    // (never overwritten) mean nothing extruding was ever parsed
    pub print_bounds_min_x: f64,
    pub print_bounds_min_y: f64,
    pub print_bounds_min_z: f64,
    pub print_bounds_max_x: f64,
    pub print_bounds_max_y: f64,
    pub print_bounds_max_z: f64,
}


impl Default for FileProcessor {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_validate_file_content() {
        // Valid G-code
        let valid_gcode = "; Test G-code\nG28 ; Home\nG0 X10 Y20\nG1 X15 Y25 E0.1\nM104 S200";
        assert!(FileProcessor::validate_file_content(valid_gcode).is_ok());
        
        // Empty file
        assert!(FileProcessor::validate_file_content("").is_err());
        
        // Not G-code
        let not_gcode = "This is just text\nwith some lines\nbut no G-code commands";
        assert!(FileProcessor::validate_file_content(not_gcode).is_err());
    }
    
    #[test]
    fn test_process_simple_file() {
        let mut processor = FileProcessor::new();
        
        let simple_gcode = concat!(
            "; Test file\n",
            "G28 ; Home all axes\n", 
            "G0 X10 Y20 Z5\n",
            "G1 X15 Y25 E0.1 F1500\n",
            "M104 S200\n"
        );
        
        let result = processor.process_file_content(simple_gcode, None);
        assert!(result.is_ok());
        
        let (gcode_lines, position_tracker) = result.unwrap();
        assert!(gcode_lines.len() >= 4); // At least the lines we specified
        assert!(!position_tracker.is_empty()); // Should have at least one extruding move
    }

    #[test]
    fn test_split_lines_keep_cr_matches_byte_offsets() {
        // Regression: str::lines() strips '\r', which previously undercounted each CRLF line's
        // consumed bytes by one and drifted file_position out of sync on Windows-authored files
        let crlf = "G28\r\nG1 X10 Y20\r\nG1 X15 Y25\r\n";
        let lines = split_lines_keep_cr(crlf);
        assert_eq!(lines, vec!["G28\r", "G1 X10 Y20\r", "G1 X15 Y25\r"]);

        let mut offset = 0usize;
        for line in &lines {
            assert_eq!(&crlf[offset..offset + line.len()], *line);
            offset += line.len() + 1; // +1 for the '\n' that split_lines_keep_cr consumed
        }
        assert_eq!(offset, crlf.len());
    }

    #[test]
    fn test_process_file_content_crlf_positions() {
        let mut processor = FileProcessor::new();
        let crlf_gcode = "G28\r\nG1 X10 Y20 E1 F1500\r\nG1 X15 Y25 E2\r\n";

        let result = processor.process_file_content(crlf_gcode, None);
        assert!(result.is_ok());

        let (_, position_tracker) = result.unwrap();
        // Every recorded file_position must land exactly on the start of a real line
        for &pos in position_tracker.keys() {
            assert!((pos as usize) < crlf_gcode.len());
            assert!(pos == 0 || crlf_gcode.as_bytes()[pos as usize - 1] == b'\n');
        }
    }

    #[test]
    fn test_settings_survive_reset_across_multiple_loads() {
        // Previously, settings pushed in from the consumer (zBelt, workplace offsets, CNC mode)
        // never reached the WASM parser at all - process_file_content only ever saw raw file
        // text. Verifies they're applied on the very first load AND survive properties.reset()
        // on every subsequent load of the same FileProcessor instance (matching the TS
        // Processor's own sticky-pending-settings pattern).
        let mut processor = FileProcessor::new();
        processor.set_z_belt(true, 45.0);
        processor.set_cnc_mode(true);
        processor.set_workplace_offsets(vec![
            crate::gcode_line::Vector3 { x: 0.0, y: 0.0, z: 0.0 },
            crate::gcode_line::Vector3 { x: 10.0, y: 20.0, z: 0.0 },
        ]);
        processor.set_current_workplace_index(1);

        assert!(processor.properties.z_belt);
        assert!(processor.properties.cnc_mode);
        assert_eq!(processor.properties.current_workplace_idx, 1);
        assert_eq!(processor.properties.current_workplace().x, 10.0);

        // First load
        let _ = processor.process_file_content("G28\nG1 X1 Y1 E1 F1200\n", None);
        assert!(processor.properties.z_belt, "zBelt should survive the first load's reset()");
        assert_eq!(processor.properties.current_workplace_idx, 1, "workplace index should survive reset()");

        // Second load on the same instance - reset() runs again
        let _ = processor.process_file_content("G28\nG1 X2 Y2 E1 F1200\n", None);
        assert!(processor.properties.z_belt, "zBelt should survive the second load's reset()");
        assert!(processor.properties.cnc_mode);
        assert_eq!(processor.properties.current_workplace_idx, 1);
        assert_eq!(processor.properties.current_workplace().x, 10.0);
    }
}
