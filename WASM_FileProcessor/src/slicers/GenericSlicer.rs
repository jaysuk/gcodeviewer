use crate::gcode_line::Color4;
use crate::slicers::{FeatureState, LayerInfo, SlicerBase};

/// Generic slicer implementation (fallback for unknown slicers) - mirrors TS's GenericBase
/// (src/GCodeParsers/genericbase.ts), which is a literally empty subclass of SlicerBase: no
/// feature parsing at all, so every move renders with the SlicerBase defaults (white,
/// perimeter=true, support=false) for the whole file.
pub struct GenericSlicer {
    name: String,
    state: FeatureState,
}

impl GenericSlicer {
    pub fn new() -> Self {
        Self {
            name: "Generic".to_string(),
            state: FeatureState::default(),
        }
    }
}

impl SlicerBase for GenericSlicer {
    fn process_comment(&mut self, _comment: &str) {
        // Generic slicer doesn't parse features - matches TS's empty GenericBase
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

    fn detect_slicer(_file_content: &str) -> bool
    where
        Self: Sized,
    {
        // Generic slicer is always a fallback
        true
    }

    fn get_name(&self) -> &str {
        &self.name
    }

    fn get_version_info(&self, _file_content: &str) -> Option<String> {
        None
    }
}

impl Default for GenericSlicer {
    fn default() -> Self {
        Self::new()
    }
}
