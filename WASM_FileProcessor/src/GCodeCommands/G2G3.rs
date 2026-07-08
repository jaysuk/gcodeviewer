use crate::gcode_line::{ArcMove, Color4, GCodeLine, MoveData, Vector3};
use crate::processor_properties::ProcessorProperties;
use crate::utils::{parse_number_fast, skip_whitespace, tessellate_arc, ArcPlane};

fn map_arc_plane(plane: &crate::processor_properties::ArcPlane) -> ArcPlane {
    match plane {
        crate::processor_properties::ArcPlane::XY => ArcPlane::XY,
        crate::processor_properties::ArcPlane::XZ => ArcPlane::XZ,
        crate::processor_properties::ArcPlane::YZ => ArcPlane::YZ,
    }
}

/// Parse G2 (clockwise arc) and G3 (counter-clockwise arc) commands - a faithful port of
/// src/GCodeCommands/g2g3.ts + src/util.ts's doArc, including the Babylon-space coordinate swap
/// and per-axis workplace-offset application that G0G1.rs already applies (this used to parse
/// raw, un-swapped coordinates and write them straight into properties.current_position, which
/// every subsequent G0/G1 then misinterpreted as Babylon space - one arc corrupted every move
/// after it).
///
/// Format: G2/G3 Xnnn Ynnn Znnn Innn Jnnn Knnn Ennn Fnnn
/// I, J, K are the arc center offsets from start position (raw, never offset or swapped).
/// R can be used instead of I/J for radius.
pub fn parse_arc_move(
    properties: &mut ProcessorProperties,
    line: &str,
    is_clockwise: bool,
    file_position: u32,
    line_number: u32,
) -> Result<GCodeLine, String> {
    let start_pos = properties.current_position.clone();

    // Babylon-space target, initialized to current position and updated per-axis exactly like
    // G0G1.rs (Y-token writes the Z field, Z-token writes the Y field - see the "CRITICAL FIX"
    // comments there for why).
    let mut x = start_pos.x;
    let mut y = start_pos.y;
    let mut z = start_pos.z;

    // Raw I/J/K/R - never swapped, never offset (matches TS's getNumber(token, i, false, 0),
    // which always takes the `number + offset` branch with offset=0 regardless of mode)
    let mut i: f64 = 0.0;
    let mut j: f64 = 0.0;
    let mut k: f64 = 0.0;
    let mut radius: Option<f64> = None;

    let mut e_seen = false;
    let mut e_value = 0.0;
    let mut f_seen = false;
    let mut f_value = 0.0;

    let line_bytes = line.as_bytes();
    let mut pos = 0;

    // Skip G2/G3 command token
    while pos < line_bytes.len() && line_bytes[pos] != b' ' && line_bytes[pos] != b'\t' {
        pos += 1;
    }

    while pos < line_bytes.len() {
        pos = skip_whitespace(line_bytes, pos);
        if pos >= line_bytes.len() {
            break;
        }
        let param_char = line_bytes[pos] as char;
        pos += 1;

        match param_char {
            'X' | 'x' => {
                let parsed = parse_number_fast(&line_bytes, pos).ok_or("Failed to parse number")?;
                let value = parsed.value;
                pos += parsed.consumed_bytes;
                x = if properties.absolute_positioning {
                    value + properties.current_workplace().x
                } else {
                    start_pos.x + value
                };
            }
            'Y' | 'y' => {
                let parsed = parse_number_fast(&line_bytes, pos).ok_or("Failed to parse number")?;
                let value = parsed.value;
                pos += parsed.consumed_bytes;
                // gcode Y -> Babylon z (matches G0G1.rs)
                z = if properties.absolute_positioning {
                    value + properties.current_workplace().y
                } else {
                    start_pos.z + value
                };
            }
            'Z' | 'z' => {
                let parsed = parse_number_fast(&line_bytes, pos).ok_or("Failed to parse number")?;
                let value = parsed.value;
                pos += parsed.consumed_bytes;
                // gcode Z -> Babylon y (matches G0G1.rs)
                y = if properties.absolute_positioning {
                    value + properties.current_workplace().z
                } else {
                    start_pos.y + value
                };
            }
            'I' | 'i' => {
                let parsed = parse_number_fast(&line_bytes, pos).ok_or("Failed to parse number")?;
                i = parsed.value;
                pos += parsed.consumed_bytes;
            }
            'J' | 'j' => {
                let parsed = parse_number_fast(&line_bytes, pos).ok_or("Failed to parse number")?;
                j = parsed.value;
                pos += parsed.consumed_bytes;
            }
            'K' | 'k' => {
                let parsed = parse_number_fast(&line_bytes, pos).ok_or("Failed to parse number")?;
                k = parsed.value;
                pos += parsed.consumed_bytes;
            }
            'R' | 'r' => {
                let parsed = parse_number_fast(&line_bytes, pos).ok_or("Failed to parse number")?;
                radius = Some(parsed.value);
                pos += parsed.consumed_bytes;
            }
            'E' | 'e' => {
                let parsed = parse_number_fast(&line_bytes, pos).ok_or("Failed to parse number")?;
                e_seen = true;
                e_value = parsed.value;
                pos += parsed.consumed_bytes;
            }
            'F' | 'f' => {
                let parsed = parse_number_fast(&line_bytes, pos).ok_or("Failed to parse number")?;
                f_seen = true;
                f_value = parsed.value;
                pos += parsed.consumed_bytes;
            }
            ';' => break,
            _ => {
                while pos < line_bytes.len() && !line_bytes[pos].is_ascii_whitespace() {
                    pos += 1;
                }
            }
        }
    }

    let end_pos = Vector3 { x, y, z };

    // Matches g2g3.ts exactly: extruding = (E token present and > 0) || cncMode
    let extruding = (e_seen && e_value > 0.0) || properties.cnc_mode;

    // Feed rate is only updated (and folded into min/max) when extruding - matches TS's
    // `if (fToken !== undefined && move.extruding) { props.CurrentFeedRate = ... }`
    if f_seen && extruding {
        properties.update_feed_rate(f_value);
    }
    let feed_rate = properties.current_feed_rate;

    let tessellation = tessellate_arc(
        start_pos.clone(),
        end_pos.clone(),
        i,
        j,
        k,
        radius,
        is_clockwise,
        map_arc_plane(&properties.arc_plane),
        0.5,
        properties.fix_radius,
    );

    let color = properties.current_feature_color.clone();
    let is_perimeter = properties.current_is_perimeter;
    let is_support = properties.current_is_support;
    let tool = properties.current_tool.tool_number;

    let mut segments: Vec<MoveData> = Vec::with_capacity(tessellation.intermediate_points.len());
    let mut prev = start_pos.clone();
    for point in &tessellation.intermediate_points {
        let mut seg = MoveData::new(file_position, line_number, line.to_string());
        seg.tool = tool;
        seg.start = prev.clone();
        seg.end = point.clone();
        seg.extruding = extruding;
        seg.color = color.clone();
        seg.feed_rate = feed_rate;
        seg.is_perimeter = is_perimeter;
        seg.is_support = is_support;
        seg.color_id = [
            ((line_number >> 16) & 0xFF) as u8,
            ((line_number >> 8) & 0xFF) as u8,
            (line_number & 0xFF) as u8,
        ];
        prev = point.clone();
        segments.push(seg);
    }

    // The position only advances if tessellation actually produced points - matches g2g3.ts's
    // `curPt` accumulator exactly: it starts at the pre-arc position and is only overwritten by
    // iterating arcResult.points, so a degenerate arc (no I/J/R, or a zero-length chord) leaves
    // current_position untouched regardless of what X/Y/Z was parsed from the line.
    if let Some(last) = segments.last() {
        properties.current_position = last.end.clone();

        // Height/print-bounds tracking - g2g3.ts previously updated neither (an arc-only file
        // reported maxHeight 0); now mirrors G0G1.rs, tracking every tessellated segment endpoint
        // rather than just the arc's overall endpoint, since a helical arc's Z can vary along its
        // length.
        for seg in &segments {
            properties.update_height(seg.end.y);
            if extruding {
                properties.update_print_bounds(seg.end.x, seg.end.y, seg.end.z);
            }
        }
    }

    properties.total_rendered_segments += segments.len() as u32;

    let arc_move = ArcMove {
        file_position,
        line_number,
        original_line: line.to_string(),
        tool,
        start: start_pos,
        end: end_pos,
        center: Vector3 { x: 0.0, y: 0.0, z: 0.0 }, // Informational only - not read by any consumer; the real center is computed in gcode space inside tessellate_arc
        radius: radius.unwrap_or(0.0),
        clockwise: is_clockwise,
        extruding,
        color,
        feed_rate,
        segments,
    };

    Ok(GCodeLine::Arc(arc_move))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_g2_arc_babylon_swap() {
        // Babylon space: current_position.z holds gcode Y, current_position.y holds gcode Z
        // (height). A G2 X20 Y20 (gcode X20 Y20, implicit Z unchanged) arc should end with
        // end.x == 20 (gcode X), end.z == 20 (gcode Y), end.y == current height (unchanged).
        let mut props = ProcessorProperties::new();
        props.current_position = Vector3 { x: 10.0, y: 0.3, z: 10.0 }; // gcode (10, 10, 0.3)

        let result = parse_arc_move(&mut props, "G2 X20 Y20 I5 J5 E0.1 F1500", true, 100, 1);
        assert!(result.is_ok());
        if let Ok(GCodeLine::Arc(arc)) = result {
            assert!((arc.end.x - 20.0).abs() < 1e-9);
            assert!((arc.end.z - 20.0).abs() < 1e-9, "expected gcode Y (Babylon z) == 20, got {}", arc.end.z);
            assert!((arc.end.y - 0.3).abs() < 1e-9, "expected height (Babylon y) unchanged at 0.3, got {}", arc.end.y);
            assert!(arc.extruding);
            assert!(!arc.segments.is_empty());
        } else {
            panic!("expected an Arc");
        }
    }

    #[test]
    fn test_parse_g3_arc_ccw() {
        let mut props = ProcessorProperties::new();
        props.current_position = Vector3 { x: 10.0, y: 0.2, z: 10.0 };

        let result = parse_arc_move(&mut props, "G3 X20 Y10 I5 J0 F1200", false, 200, 2);
        assert!(result.is_ok());
        if let Ok(GCodeLine::Arc(arc)) = result {
            assert!(!arc.clockwise);
            assert!(!arc.extruding); // no E parameter
        } else {
            panic!("expected an Arc");
        }
    }

    #[test]
    fn test_degenerate_arc_does_not_advance_position() {
        // No I/J/R at all - doArc returns zero points, and current_position must not change,
        // regardless of the parsed X/Y target (mirrors g2g3.ts's curPt behavior exactly).
        let mut props = ProcessorProperties::new();
        props.current_position = Vector3 { x: 10.0, y: 0.0, z: 10.0 };

        let result = parse_arc_move(&mut props, "G2 X20 Y20", true, 300, 3);
        assert!(result.is_ok());
        assert_eq!(props.current_position.x, 10.0);
        assert_eq!(props.current_position.z, 10.0);
        if let Ok(GCodeLine::Arc(arc)) = result {
            assert!(arc.segments.is_empty());
        }
    }

    #[test]
    fn test_arc_updates_height_and_print_bounds() {
        let mut props = ProcessorProperties::new();
        props.current_position = Vector3 { x: 0.0, y: 0.5, z: 0.0 };

        let result = parse_arc_move(&mut props, "G2 X10 Y10 Z0.7 I5 J0 E1 F1200", true, 400, 4);
        assert!(result.is_ok());
        assert!(props.max_height >= 0.5, "arc should have updated max_height");
        assert!(props.print_bounds_max_x.is_finite(), "arc should have updated print bounds");
    }
}
