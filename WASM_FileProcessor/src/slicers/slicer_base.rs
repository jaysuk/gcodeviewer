use crate::gcode_line::Color4;

/// Layer information
#[derive(Debug, Clone)]
pub struct LayerInfo {
    pub layer_number: u32,
    pub layer_height: f64,
    pub z_position: f64,
}

/// Current feature-coloring state, mirroring TypeScript's SlicerBase instance fields exactly
/// (src/GCodeParsers/slicerbase.ts: currentFeatureColor/currentIsPerimeter/currentIsSupport).
/// Every slicer shares these defaults - white, perimeter=true, support=false - which matter: this
/// is what a file renders with *before* its first `;TYPE:` comment, not "Perimeter" as an earlier
/// version of the Rust port assumed.
#[derive(Clone, Debug)]
pub struct FeatureState {
    pub color: Color4,
    pub is_perimeter: bool,
    pub is_support: bool,
}

impl Default for FeatureState {
    fn default() -> Self {
        Self {
            color: Color4::white(),
            is_perimeter: true,
            is_support: false,
        }
    }
}

/// Base trait for slicer-specific behavior - mirrors TypeScript's SlicerBase
/// (src/GCodeParsers/slicerbase.ts) exactly: `process_comment` is stateful (updates
/// color/is_perimeter/is_support in place), and the getters read back that state rather than
/// re-parsing the comment on every call.
pub trait SlicerBase {
    /// Process a `;TYPE:` comment and update feature-coloring state (mirrors TS processComment)
    fn process_comment(&mut self, comment: &str);
    fn is_perimeter(&self) -> bool;
    fn is_support(&self) -> bool;
    fn get_feature_color(&self) -> Color4;
    fn parse_layer_info(&self, comment: &str) -> Option<LayerInfo>;
    fn get_temperature_from_comment(&self, comment: &str) -> Option<f64>;
    fn detect_slicer(file_content: &str) -> bool
    where
        Self: Sized;
    fn get_name(&self) -> &str;
    fn get_version_info(&self, file_content: &str) -> Option<String>;
}

/// Detect slicer type from file content - order and patterns match TypeScript's
/// slicerFactory.ts SLICER_PATTERNS exactly: PrusaSlicer, Cura, SuperSlicer, ideaMaker, Kiri:Moto,
/// OrcaSlicer, then Generic as the fallback.
pub fn detect_slicer(file_content: &str) -> Box<dyn SlicerBase> {
    use crate::slicers::CuraSlicer::CuraSlicer;
    use crate::slicers::GenericSlicer::GenericSlicer;
    use crate::slicers::IdeaMakerSlicer::IdeaMakerSlicer;
    use crate::slicers::KiriMotoSlicer::KiriMotoSlicer;
    use crate::slicers::OrcaSlicer::OrcaSlicer;
    use crate::slicers::PrusaSlicer::PrusaSlicer;
    use crate::slicers::SuperSlicer::SuperSlicer;

    // Check first few KB for slicer signatures, matching TS's slicerFactory.ts substring window
    let header = if file_content.len() > 10000 {
        &file_content[..10000]
    } else {
        file_content
    };

    if PrusaSlicer::detect_slicer(header) {
        return Box::new(PrusaSlicer::new());
    }
    if CuraSlicer::detect_slicer(header) {
        return Box::new(CuraSlicer::new());
    }
    if SuperSlicer::detect_slicer(header) {
        return Box::new(SuperSlicer::new());
    }
    if IdeaMakerSlicer::detect_slicer(header) {
        return Box::new(IdeaMakerSlicer::new());
    }
    if KiriMotoSlicer::detect_slicer(header) {
        return Box::new(KiriMotoSlicer::new());
    }
    if OrcaSlicer::detect_slicer(header) {
        return Box::new(OrcaSlicer::new());
    }

    Box::new(GenericSlicer::new())
}
