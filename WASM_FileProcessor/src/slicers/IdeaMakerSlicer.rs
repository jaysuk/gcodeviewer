use crate::gcode_line::Color4;
use crate::slicers::{FeatureState, LayerInfo, SlicerBase};

/// (key, color, is_perimeter, is_support) - transcribed verbatim from
/// src/GCodeParsers/ideamaker.ts. Exact-string lookup, no normalization heuristics.
const FEATURES: &[(&str, [f64; 4], bool, bool)] = &[
    ("PERIMETER", [1.0, 0.9, 0.3, 1.0], false, false),
    ("EXTERNAL PERIMETER", [1.0, 0.5, 0.2, 1.0], true, false),
    ("INTERNAL INFILL", [0.59, 0.19, 0.16, 1.0], false, false),
    ("SOLID INFILL", [0.59, 0.19, 0.8, 1.0], false, false),
    ("TOP SOLID INFILL", [0.95, 0.25, 0.25, 1.0], true, false),
    ("BRIDGE INFILL", [0.3, 0.5, 0.73, 1.0], false, false),
    ("GAP FILL", [1.0, 1.0, 1.0, 1.0], false, false),
    ("SKIRT", [0.0, 0.53, 0.43, 1.0], false, false),
    ("SKIRT/BRIM", [0.0, 0.53, 0.43, 1.0], false, false),
    ("SUPPORTED MATERIAL", [0.0, 1.0, 0.0, 1.0], false, true),
    ("SUPPORTED MATERIAL INTERFACE", [0.0, 0.5, 0.0, 1.0], false, true),
    ("CUSTOM", [0.5, 0.5, 0.5, 1.0], false, false),
    ("UNKNOWN", [0.5, 0.5, 0.5, 1.0], false, false),
    ("SUPPORT MATERIAL", [0.5, 0.5, 0.5, 1.0], false, true),
    ("SUPPORT MATERIAL INTERFACE", [0.5, 0.5, 0.5, 1.0], false, true),
    ("OVERHANG PERIMETER", [0.5, 0.5, 0.5, 1.0], true, false),
    ("WIPE TOWER", [0.5, 0.5, 0.5, 1.0], true, false),
];

pub struct IdeaMakerSlicer {
    name: String,
    state: FeatureState,
}

impl IdeaMakerSlicer {
    pub fn new() -> Self {
        Self {
            name: "ideaMaker".to_string(),
            state: FeatureState::default(),
        }
    }
}

impl SlicerBase for IdeaMakerSlicer {
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

    fn parse_layer_info(&self, _comment: &str) -> Option<LayerInfo> {
        None
    }

    fn get_temperature_from_comment(&self, _comment: &str) -> Option<f64> {
        None
    }

    fn detect_slicer(file_content: &str) -> bool
    where
        Self: Sized,
    {
        file_content.contains("Sliced by ideaMaker")
    }

    fn get_name(&self) -> &str {
        &self.name
    }

    fn get_version_info(&self, _file_content: &str) -> Option<String> {
        None
    }
}

impl Default for IdeaMakerSlicer {
    fn default() -> Self {
        Self::new()
    }
}
