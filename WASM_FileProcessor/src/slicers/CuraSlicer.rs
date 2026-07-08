use crate::gcode_line::Color4;
use crate::slicers::{FeatureState, LayerInfo, SlicerBase};

/// (key, color, is_perimeter, is_support) - transcribed verbatim from src/GCodeParsers/cura.ts.
/// Cura does an exact-string lookup (no case normalization) - matches TS's
/// `this.featureList[this.feature]` where `this.feature` is the raw, untouched substring after
/// `;TYPE:`.
const FEATURES: &[(&str, [f64; 4], bool, bool)] = &[
    ("SKIN", [1.0, 0.9, 0.3, 1.0], true, false),
    ("WALL-OUTER", [1.0, 0.5, 0.2, 1.0], true, false),
    ("WALL-INNER", [0.59, 0.19, 0.16, 1.0], false, false),
    ("FILL", [0.95, 0.25, 0.25, 1.0], false, false),
    ("SKIRT", [0.0, 0.53, 0.43, 1.0], false, false),
    ("SUPPORT", [0.0, 0.53, 0.43, 1.0], false, true),
    ("CUSTOM", [0.5, 0.5, 0.5, 1.0], false, false),
    ("UNKNOWN", [0.5, 0.5, 0.5, 1.0], false, false),
];

pub struct CuraSlicer {
    name: String,
    state: FeatureState,
}

impl CuraSlicer {
    pub fn new() -> Self {
        Self {
            name: "Cura".to_string(),
            state: FeatureState::default(),
        }
    }
}

impl SlicerBase for CuraSlicer {
    fn process_comment(&mut self, comment: &str) {
        let Some(feature_raw) = comment.strip_prefix(";TYPE:") else {
            return;
        };
        let key = feature_raw.trim();
        if let Some(&(_, color, is_perimeter, is_support)) = FEATURES.iter().find(|(k, ..)| *k == key) {
            self.state.color = Color4::new(color[0], color[1], color[2], color[3]);
            self.state.is_perimeter = is_perimeter;
            self.state.is_support = is_support;
        } else {
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
        // Cura format: ";LAYER:0", ";LAYER_COUNT:245"
        if let Some(rest) = comment.strip_prefix(";LAYER:") {
            let layer_str = rest.trim();
            if let Ok(layer_num) = layer_str.parse::<u32>() {
                return Some(LayerInfo {
                    layer_number: layer_num,
                    layer_height: 0.2,
                    z_position: layer_num as f64 * 0.2,
                });
            }
        }
        None
    }

    fn get_temperature_from_comment(&self, comment: &str) -> Option<f64> {
        if comment.contains("temperature") || comment.contains("M104") || comment.contains("M109") {
            for part in comment.split_whitespace() {
                if let Some(rest) = part.strip_prefix('S') {
                    if let Ok(temp) = rest.parse::<f64>() {
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
        // TS's slicerFactory.ts matches only ';Generated with Cura_SteamEngine' - the generic
        // ';FLAVOR:' header this previously also matched on appears in plain Marlin-flavor files
        // from other slicers too, misrouting them into Cura's feature-comment parsing
        file_content.contains(";Generated with Cura_SteamEngine")
    }

    fn get_name(&self) -> &str {
        &self.name
    }

    fn get_version_info(&self, file_content: &str) -> Option<String> {
        for line in file_content.lines().take(50) {
            if line.contains("Cura_SteamEngine") {
                if let Some(start) = line.find("Cura_SteamEngine ") {
                    let version_part = &line[start + 17..];
                    let end = version_part.find(' ').unwrap_or(version_part.len());
                    return Some(version_part[..end].trim().to_string());
                }
            }
        }
        None
    }
}

impl Default for CuraSlicer {
    fn default() -> Self {
        Self::new()
    }
}
