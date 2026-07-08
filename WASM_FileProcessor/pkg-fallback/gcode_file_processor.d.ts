// Type declarations for the fallback stub / the real wasm-bindgen output.
// Keep this in sync with WASM_FileProcessor/src/lib.rs's #[wasm_bindgen] surface.

export type ProgressCallback = (progress: number, label: string) => void

export class ProcessingResult {
   readonly success: boolean
   readonly error_message: string
   readonly line_count: number
   readonly move_count: number
   readonly processing_time_ms: number
   has_error(): boolean
}

export class PositionData {
   readonly x: number
   readonly y: number
   readonly z: number
   readonly feed_rate: number
   readonly extruding: boolean
}

export class RenderBuffers {
   readonly segment_count: number
   readonly matrix_data: Float32Array
   readonly color_data: Float32Array
   readonly pick_data: Float32Array
   readonly file_position_data: Float32Array
   readonly file_end_position_data: Float32Array
   readonly tool_data: Float32Array
   readonly feed_rate_data: Float32Array
   readonly is_perimeter_data: Float32Array
}

export class GCodeProcessor {
   constructor()
   process_file(file_content: string, progress_callback?: ProgressCallback): ProcessingResult
   get_position_data(file_position: number): PositionData | undefined
   get_sorted_positions(): Uint32Array
   get_position_count(): number
   find_closest_position(target_position: number): number | undefined
   generate_render_buffers(nozzle_size: number, padding: number, progress_callback?: ProgressCallback): RenderBuffers
   free(): void
}

export function get_version(): string

export default function init(input?: unknown): Promise<unknown>
