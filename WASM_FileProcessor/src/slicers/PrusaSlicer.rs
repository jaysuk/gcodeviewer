use crate::gcode_line::Color4;
use crate::slicers::{FeatureState, LayerInfo, SlicerBase};

/// (key, color, is_perimeter, is_support) - transcribed verbatim from
/// src/GCodeParsers/prusaslicer.ts's featureList, including the "Look up colors" entries
/// (SUPPORT MATERIAL / SUPPORT MATERIAL INTERFACE are distinct keys from SUPPORTED MATERIAL /
/// SUPPORTED MATERIAL INTERFACE - not typos, both exist in the TS table).
const FEATURES: &[(&str, [f64; 4], bool, bool)] = &[
    ("PERIMETER", [1.0, 0.9, 0.3, 1.0], true, false),
    ("EXTERNAL PERIMETER", [1.0, 0.5, 0.2, 1.0], true, false),
    ("INTERNAL INFILL", [0.59, 0.19, 0.16, 1.0], false, false),
    ("SOLID INFILL", [0.59, 0.19, 0.8, 1.0], false, false),
    ("TOP SOLID INFILL", [0.95, 0.25, 0.25, 1.0], false, false),
    ("BRIDGE INFILL", [0.3, 0.5, 0.73, 1.0], false, false),
    ("GAP FILL", [1.0, 1.0, 1.0, 1.0], false, false),
    ("SKIRT", [0.0, 0.53, 0.43, 1.0], false, false),
    ("SKIRT/BRIM", [0.0, 0.53, 0.43, 1.0], false, false),
    ("SUPPORTED MATERIAL", [0.0, 1.0, 0.0, 1.0], false, true),
    ("SUPPORTED MATERIAL INTERFACE", [0.0, 0.5, 0.0, 1.0], false, true),
    ("CUSTOM", [0.5, 0.5, 0.5, 1.0], false, false),
    ("UNKNOWN", [0.5, 0.5, 0.5, 1.0], false, false),
    // "Look up colors" section in the TS source
    ("SUPPORT MATERIAL", [0.5, 0.5, 0.5, 1.0], false, true),
    ("SUPPORT MATERIAL INTERFACE", [0.5, 0.5, 0.5, 1.0], false, true),
    ("OVERHANG PERIMETER", [0.5, 0.5, 0.5, 1.0], true, false),
    ("WIPE TOWER", [0.5, 0.5, 0.5, 1.0], false, false),
];

fn find(key: &str) -> Option<&'static (&'static str, [f64; 4], bool, bool)> {
    FEATURES.iter().find(|(k, ..)| *k == key)
}

pub struct PrusaSlicer {
    name: String,
    state: FeatureState,
}

impl PrusaSlicer {
    pub fn new() -> Self {
        Self {
            name: "PrusaSlicer".to_string(),
            state: FeatureState::default(),
        }
    }

    // Synonym/variant heuristics - transcribed from prusaslicer.ts's processComment, which runs
    // these only when the normalized key doesn't match a table entry directly
    fn synonym_lookup(key: &str) -> Option<&'static (&'static str, [f64; 4], bool, bool)> {
        let has = |s: &str| key.contains(s);
        if has("TOP") && has("SOLID") && has("INFILL") {
            find("TOP SOLID INFILL")
        } else if has("SOLID") && has("INFILL") {
            find("SOLID INFILL")
        } else if has("BRIDGE") && has("INFILL") {
            find("BRIDGE INFILL")
        } else if has("GAP") && has("FILL") {
            find("GAP FILL")
        } else if has("EXTERNAL") && has("PERIMETER") {
            find("EXTERNAL PERIMETER")
        } else if has("INTERNAL") && has("INFILL") {
            find("INTERNAL INFILL")
        } else if has("SUPPORT") && has("INTERFACE") {
            find("SUPPORT MATERIAL INTERFACE").or_else(|| find("SUPPORTED MATERIAL INTERFACE"))
        } else if has("SUPPORT") {
            find("SUPPORT MATERIAL").or_else(|| find("SUPPORTED MATERIAL"))
        } else if has("SKIRT") || has("BRIM") {
            find("SKIRT/BRIM").or_else(|| find("SKIRT"))
        } else {
            None
        }
    }
}

impl SlicerBase for PrusaSlicer {
    fn process_comment(&mut self, comment: &str) {
        let Some(feature_raw) = comment.strip_prefix(";TYPE:") else {
            return;
        };
        // Normalize: uppercase and collapse/harmonize separators (matches prusaslicer.ts exactly)
        let normalized = feature_raw.trim().to_uppercase().replace(['-', '_'], " ");
        let key: String = normalized.split_whitespace().collect::<Vec<_>>().join(" ");

        let found = find(&key).or_else(|| Self::synonym_lookup(&key));

        if let Some(&(_, color, is_perimeter, is_support)) = found {
            self.state.color = Color4::new(color[0], color[1], color[2], color[3]);
            self.state.is_perimeter = is_perimeter;
            self.state.is_support = is_support;
        } else {
            // Unknown feature type - matches TS's fallback (reportMissingFeature + white/perimeter)
            self.state.color = Color4::white();
            self.state.is_perimeter = true;
            self.state.is_support = false;
        }
    }

    fn is_perimeter(&self) -> bool {
        self.state.is_perimeter
    }

    fn is_support(&self) -> bool {
        self.state.is_support
    }

    fn get_feature_color(&self) -> Color4 {
        self.state.color.clone()
    }

    fn parse_layer_info(&self, comment: &str) -> Option<LayerInfo> {
        // PrusaSlicer format: "; LAYER_CHANGE\n; Z:0.3\n; layer num/total_layer_count: 1/245"
        if comment.contains("LAYER_CHANGE") || comment.starts_with("; Z:") {
            if let Some(z_start) = comment.find("; Z:") {
                let z_line = &comment[z_start + 4..];
                let z_end = z_line.find('\n').unwrap_or(z_line.len());
                let z_str = z_line[..z_end].trim();
                if let Ok(z_pos) = z_str.parse::<f64>() {
                    let layer_num = if let Some(layer_start) = comment.find("layer num/total_layer_count: ") {
                        let layer_line = &comment[layer_start + 29..];
                        if let Some(slash_pos) = layer_line.find('/') {
                            layer_line[..slash_pos].trim().parse::<u32>().unwrap_or(0)
                        } else {
                            0
                        }
                    } else {
                        0
                    };

                    return Some(LayerInfo {
                        layer_number: layer_num,
                        layer_height: 0.2,
                        z_position: z_pos,
                    });
                }
            }
        }
        None
    }

    fn get_temperature_from_comment(&self, comment: &str) -> Option<f64> {
        if comment.contains("temperature") {
            if let Some(temp_start) = comment.find("temperature") {
                let temp_substr = &comment[temp_start..];
                for word in temp_substr.split_whitespace() {
                    if let Ok(temp) = word.trim_matches(&[';', '°', 'C', '=', ':'][..]).parse::<f64>() {
                        if temp > 0.0 && temp < 500.0 {
                            return Some(temp);
                        }
                    }
                }
            }
        }
        None
    }

    fn detect_slicer(file_content: &str) -> bool
    where
        Self: Sized,
    {
        file_content.contains("; generated by PrusaSlicer")
    }

    fn get_name(&self) -> &str {
        &self.name
    }

    fn get_version_info(&self, file_content: &str) -> Option<String> {
        if let Some(start) = file_content.find("; generated by PrusaSlicer ") {
            let version_line = &file_content[start + 27..];
            let end = version_line.find(" on ").or_else(|| version_line.find('\n')).unwrap_or(version_line.len());
            return Some(version_line[..end].trim().to_string());
        }
        None
    }
}

impl Default for PrusaSlicer {
    fn default() -> Self {
        Self::new()
    }
}
