import init, { GCodeProcessor, ProcessingResult, PositionData, RenderBuffers, get_version } from '../WASM_FileProcessor/pkg/gcode_file_processor';

export interface WasmProcessingResult {
    success: boolean;
    errorMessage: string;
    lineCount: number;
    moveCount: number;
    processingTimeMs: number;
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

    async processFile(
        content: string, 
        progressCallback?: (progress: number, label: string) => void
    ): Promise<WasmProcessingResult> {
        if (!this.initialized || !this.processor) {
            throw new Error('WASM processor not initialized. Call initialize() first.');
        }

        const result: ProcessingResult = this.processor.process_file(content, progressCallback);
        
        return {
            success: result.success,
            errorMessage: result.error_message,
            lineCount: result.line_count,
            moveCount: result.move_count,
            processingTimeMs: result.processing_time_ms
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

    generateRenderBuffers(nozzleSize: number = 0.4, padding: number = 0, progressCallback?: (progress: number, label: string) => void): WasmRenderBuffers {
        if (!this.initialized || !this.processor) {
            throw new Error('WASM processor not initialized');
        }

        const renderBuffers: RenderBuffers = this.processor.generate_render_buffers(nozzleSize, padding, progressCallback);
        
        return {
            segmentCount: renderBuffers.segment_count,
            matrixData: new Float32Array(renderBuffers.matrix_data),
            colorData: new Float32Array(renderBuffers.color_data),
            pickData: new Float32Array(renderBuffers.pick_data),
            filePositionData: new Float32Array(renderBuffers.file_position_data),
            fileEndPositionData: new Float32Array(renderBuffers.file_end_position_data),
            toolData: new Float32Array(renderBuffers.tool_data),
            feedRateData: new Float32Array(renderBuffers.feed_rate_data),
            isPerimeterData: new Float32Array(renderBuffers.is_perimeter_data),
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