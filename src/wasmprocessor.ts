import init, { GCodeProcessor, ProcessingResult, PositionData, RenderBuffers, get_version } from '../WASM_FileProcessor/pkg/gcode_file_processor';

export interface WasmProcessingResult {
    success: boolean;
    errorMessage: string;
    // True when the load was aborted via cancelLoad() rather than failing on its own - the
    // progress callback passed to processFile() can return `true` to request cancellation, which
    // WASM checks between chunks of its own parse loop (previously cancelLoad() could only be
    // detected between JS-side chunk boundaries, so it had no way to interrupt a single
    // synchronous WASM call, however long it ran).
    cancelled: boolean;
    lineCount: number;
    moveCount: number;
    processingTimeMs: number;
    // Aggregate stats computed during WASM parsing - lets a consumer skip re-parsing the whole
    // file in TypeScript a second time just to recompute these (see Processor.loadFileWithWasm)
    maxHeight: number;
    minHeight: number;
    maxFeedRate: number;
    minFeedRate: number;
    firstGCodeByte: number;
    lastGCodeByte: number;
    printBoundsMinX: number;
    printBoundsMinY: number;
    printBoundsMinZ: number;
    printBoundsMaxX: number;
    printBoundsMaxY: number;
    printBoundsMaxZ: number;
}

export interface WasmPositionData {
    x: number;
    y: number;
    z: number;
    feedRate: number;
    extruding: boolean;
}

export interface WasmRenderBuffers {
    segmentCount: number;
    matrixData: Float32Array;
    colorData: Float32Array;
    pickData: Float32Array;
    filePositionData: Float32Array;
    fileEndPositionData: Float32Array;
    toolData: Float32Array;
    feedRateData: Float32Array;
    isPerimeterData: Float32Array;
}

export class WasmProcessor {
    private processor: GCodeProcessor | null = null;
    private initialized: boolean = false;

    async initialize(): Promise<void> {
        if (!this.initialized) {
            await init();
            this.processor = new GCodeProcessor();
            this.initialized = true;
            console.log(`WASM G-code processor initialized - v${get_version()}`);
        }
    }

    getVersion(): string {
        return get_version();
    }

    // Parse-time settings, previously never threaded through to the WASM parser at all (it only
    // ever saw raw file text) - belt printers and custom workplace offsets silently parsed with
    // the wrong kinematics whenever WASM was enabled. Sticky on the Rust side across loads
    // (survives its own internal reset()), matching Processor.ts's own pending-settings pattern.
    setZBelt(enabled: boolean, gantryAngleDegrees: number): void {
        if (!this.initialized || !this.processor) {
            throw new Error('WASM processor not initialized');
        }
        this.processor.set_z_belt(enabled, gantryAngleDegrees);
    }

    setWorkplaceOffsets(offsets: { x: number; y: number; z: number }[]): void {
        if (!this.initialized || !this.processor) {
            throw new Error('WASM processor not initialized');
        }
        const flat = new Float64Array(offsets.length * 3);
        offsets.forEach((o, idx) => {
            flat[idx * 3] = o.x;
            flat[idx * 3 + 1] = o.y;
            flat[idx * 3 + 2] = o.z;
        });
        this.processor.set_workplace_offsets(flat);
    }

    setCurrentWorkplaceIndex(index: number): void {
        if (!this.initialized || !this.processor) {
            throw new Error('WASM processor not initialized');
        }
        this.processor.set_current_workplace_index(index);
    }

    setCncMode(enabled: boolean): void {
        if (!this.initialized || !this.processor) {
            throw new Error('WASM processor not initialized');
        }
        this.processor.set_cnc_mode(enabled);
    }

    setFixRadius(enabled: boolean): void {
        if (!this.initialized || !this.processor) {
            throw new Error('WASM processor not initialized');
        }
        this.processor.set_fix_radius(enabled);
    }

    setArcPlane(plane: 'XY' | 'XZ' | 'YZ'): void {
        if (!this.initialized || !this.processor) {
            throw new Error('WASM processor not initialized');
        }
        this.processor.set_arc_plane(plane);
    }

    async processFile(
        content: string,
        // Returning `true` requests cancellation - checked between chunks of the WASM parse loop
        progressCallback?: (progress: number, label: string) => boolean | void
    ): Promise<WasmProcessingResult> {
        if (!this.initialized || !this.processor) {
            throw new Error('WASM processor not initialized. Call initialize() first.');
        }

        const result: ProcessingResult = this.processor.process_file(content, progressCallback);

        return {
            success: result.success,
            errorMessage: result.error_message,
            cancelled: result.cancelled,
            lineCount: result.line_count,
            moveCount: result.move_count,
            processingTimeMs: result.processing_time_ms,
            maxHeight: result.max_height,
            minHeight: result.min_height,
            maxFeedRate: result.max_feed_rate,
            minFeedRate: result.min_feed_rate,
            firstGCodeByte: result.first_gcode_byte,
            lastGCodeByte: result.last_gcode_byte,
            printBoundsMinX: result.print_bounds_min_x,
            printBoundsMinY: result.print_bounds_min_y,
            printBoundsMinZ: result.print_bounds_min_z,
            printBoundsMaxX: result.print_bounds_max_x,
            printBoundsMaxY: result.print_bounds_max_y,
            printBoundsMaxZ: result.print_bounds_max_z,
        };
    }

    getPositionData(filePosition: number): WasmPositionData | undefined {
        if (!this.initialized || !this.processor) {
            throw new Error('WASM processor not initialized');
        }

        const posData: PositionData | undefined = this.processor.get_position_data(filePosition);
        if (!posData) {
            return undefined;
        }

        return {
            x: posData.x,
            y: posData.y,
            z: posData.z,
            feedRate: posData.feed_rate,
            extruding: posData.extruding
        };
    }

    getSortedPositions(): Uint32Array {
        if (!this.initialized || !this.processor) {
            throw new Error('WASM processor not initialized');
        }

        return this.processor.get_sorted_positions();
    }

    getPositionCount(): number {
        if (!this.initialized || !this.processor) {
            throw new Error('WASM processor not initialized');
        }

        return this.processor.get_position_count();
    }

    findClosestPosition(targetPosition: number): number | undefined {
        if (!this.initialized || !this.processor) {
            throw new Error('WASM processor not initialized');
        }

        return this.processor.find_closest_position(targetPosition);
    }

    generateRenderBuffers(nozzleSize: number = 0.4, padding: number = 0, perimeterOnly: boolean = false, progressCallback?: (progress: number, label: string) => void): WasmRenderBuffers {
        if (!this.initialized || !this.processor) {
            throw new Error('WASM processor not initialized');
        }

        const renderBuffers: RenderBuffers = this.processor.generate_render_buffers(nozzleSize, padding, perimeterOnly, progressCallback);

        // wasm-bindgen's Vec<f32> -> Float32Array conversion already copies out of WASM linear
        // memory once - wrapping each field in `new Float32Array(...)` here was a second,
        // entirely redundant copy of buffers that scale with segment count (e.g. 16 floats/segment
        // for matrixData alone, so tens of MB on a large file).
        return {
            segmentCount: renderBuffers.segment_count,
            matrixData: renderBuffers.matrix_data,
            colorData: renderBuffers.color_data,
            pickData: renderBuffers.pick_data,
            filePositionData: renderBuffers.file_position_data,
            fileEndPositionData: renderBuffers.file_end_position_data,
            toolData: renderBuffers.tool_data,
            feedRateData: renderBuffers.feed_rate_data,
            isPerimeterData: renderBuffers.is_perimeter_data,
        };
    }

    dispose(): void {
        if (this.processor) {
            this.processor.free();
            this.processor = null;
        }
        this.initialized = false;
    }
}