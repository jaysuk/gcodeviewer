import { Base, Move, ArcMove, Move_Thin, IndexEntry } from './GCodeLines'
import ProcessorProperties from './processorproperties'
import { ProcessLine } from './GCodeCommands/processline'
import { Scene } from '@babylonjs/core/scene'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { Axis, Space } from '@babylonjs/core/Maths/math.axis'
import Tool from './tools'
import '@babylonjs/core/Meshes/thinInstanceMesh'
import GPUPicker from './gpupicker'
import { colorToNum, binarySearchClosest } from './util'
import { MoveData } from './GCodeLines/move'
import { slicerFactory } from './GCodeParsers/slicerfactory'
import LineShaderMaterial from './lineshader'
import Nozzle from './Renderables/nozzle'
import { WasmProcessor, WasmRenderBuffers } from './wasmprocessor'

export interface LoadFileResult {
   start: number
   end: number
   failed: boolean
   // True when the load was aborted via cancelLoad() rather than failing on its own - distinct
   // from failed so a consumer doesn't surface a user-initiated cancel as an error
   cancelled: boolean
   // Printer Z range spanned by extruding moves - drives a consumer's Z-clip slider bounds
   maxHeight: number
   minHeight: number
   maxFeedRate: number
   minFeedRate: number
}

// Thrown by checkCancelled() to unwind out of whichever load loop is currently running -
// caught in loadFile() and reported as cancelled rather than failed
class LoadCancelledError extends Error {}

export default class Processor {
   gCodeLines: Base[] = []
   processorProperties: ProcessorProperties = new ProcessorProperties()
   scene: Scene
   meshes: Mesh[] = []
   breakPoint = 100000
   gpuPicker: GPUPicker
   worker: Worker
   modelMaterial: LineShaderMaterial[] = []
   filePosition: number = 0
   maxIndex: number = 0
   focusedColorId = 0
   lastMeshMode = 0
   perimeterOnly = false
   originalFile: string //May or may not keep this. May force front end to reprovide or cache file.
   nozzle: Nozzle | null = null
   // Last tool table provided via setTools(), re-applied after every loadFile() resets processorProperties
   private userTools: { color: string; diameter?: number }[] | null = null
   // Live-synced workplace offsets (e.g. from the printer's object model), re-applied after every
   // loadFile() resets processorProperties - see setWorkplaceOffsets/setCurrentWorkplaceIndex
   private pendingWorkplaceOffsets: { x: number; y: number; z: number }[] | null = null
   private pendingWorkplaceIndex: number | null = null
   // Travel-line display settings, re-applied to every material created (materials are recreated
   // per loadFile())
   private showTravels = true
   private persistTravels = false
   // Feed-rate legend colors and an optional display-range override, re-applied to every material
   private minFeedColor: [number, number, number] = [0, 0, 1]
   private maxFeedColor: [number, number, number] = [1, 0, 0]
   private feedRateRangeOverride: { min: number; max: number } | null = null
   // Ghost-line opacity (while alphaMode is on) and specular lighting toggle, re-applied to every
   // material created
   private transparencyPercent = 5
   private useSpecular = false
   // Set by cancelLoad(), checked between chunks of whichever load loop is running
   private cancelRequested = false
   // Track position data for nozzle animation since Move objects get replaced with Move_Thin
   positionTracker: Map<number, { x: number; y: number; z: number; feedRate: number; extruding: boolean }> = new Map()
   // Animation playback state
   private isPlaying: boolean = false
   private playbackTimeout: number | null = null
   private sortedPositions: number[] = []
   // Progress tracking optimization
   private lastReportedProgress: number = 0
   private lastReportedChunk: number = 0
   // WASM processor for fast parsing
   private wasmProcessor: WasmProcessor | null = null
   private wasmRenderBuffers: WasmRenderBuffers | null = null
   // Processing method tracking
   private lastProcessingMethod: 'typescript' | 'wasm' | 'hybrid' | 'none' = 'none'
   private processingStats: {
      method: string
      wasmEnabled: boolean
      wasmVersion?: string
      totalTime?: number
      wasmTime?: number
      typescriptTime?: number
      wasmRenderTime?: number
      linesProcessed?: number
      movesFound?: number
      positionsExtracted?: number
      renderSegmentsGenerated?: number
   } = { method: 'none', wasmEnabled: false }

   async enableWasmProcessing(): Promise<void> {
      if (this.wasmProcessor) {
         return
      }
      // Only assign this.wasmProcessor once initialize() actually succeeds - otherwise a failed
      // init (e.g. the WASM module was never built) would permanently wedge the processor into
      // treating WASM as "enabled" (see isWasmEnabled/loadFile) while every call still throws,
      // and a retry would be impossible since the truthy field short-circuits future attempts.
      const wasmProcessor = new WasmProcessor()
      try {
         await wasmProcessor.initialize()
      } catch (error) {
         wasmProcessor.dispose()
         throw error
      }
      this.wasmProcessor = wasmProcessor
      this.processingStats.wasmEnabled = true
      console.log('WASM processing enabled for G-code parsing')
   }

   getProcessingMethod(): string {
      return this.lastProcessingMethod
   }

   getProcessingStats() {
      return { ...this.processingStats }
   }

   isWasmEnabled(): boolean {
      return this.wasmProcessor !== null && this.processingStats.wasmEnabled
   }

   private async getWasmVersion(): Promise<string> {
      try {
         return this.wasmProcessor?.getVersion() ?? 'unknown'
      } catch {
         return 'unknown'
      }
   }

   initNozzle(diameter: number = 0.4) {
      if (this.scene) {
         this.nozzle = new Nozzle(this.scene, diameter)
         // Set faster animation speed for simulation
         this.nozzle.setAnimationSpeed(10.0)
         console.log('Nozzle initialized and ready for animation')
      }
   }

   getNozzle(): Nozzle | null {
      return this.nozzle
   }

   setNozzleAnimationSpeed(speed: number) {
      this.nozzle?.setAnimationSpeed(speed)
   }

   // Places the nozzle marker at a raw XYZ instantly, bypassing the closest-tracked-file-position
   // lookup that updateFilePosition() uses - for live machine-position tracking, where the caller
   // has the real toolhead position and isn't scrubbing/playing back the loaded file
   setNozzlePosition(position: { x: number; y: number; z: number }) {
      this.nozzle?.forcePosition(position)
   }

   // Bounding box (Babylon space) over every extruding move in the loaded file, or null if
   // nothing extruding has been parsed yet - used to frame the camera on the actual print rather
   // than the whole bed/travel envelope
   getPrintBounds(): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null {
      const p = this.processorProperties
      if (!Number.isFinite(p.printBoundsMinX)) {
         return null
      }
      return {
         min: { x: p.printBoundsMinX, y: p.printBoundsMinY, z: p.printBoundsMinZ },
         max: { x: p.printBoundsMaxX, y: p.printBoundsMaxY, z: p.printBoundsMaxZ },
      }
   }

   // Replaces the tool table, e.g. from the printer's object model. Colors are hex strings like '#ff0000'
   setTools(toolData: { color: string; diameter?: number }[]) {
      if (!toolData || toolData.length === 0) {
         return
      }
      // Remembered so it survives loadFile() recreating processorProperties (and its default
      // tool table) on every file load - previously any setTools() call was silently discarded
      // as soon as the next file was opened
      this.userTools = toolData
      this.applyUserTools()
      this.modelMaterial.forEach((m) => m.updateToolColors(this.processorProperties.buildToolFloat32Array()))
   }

   private applyUserTools() {
      if (!this.userTools) {
         return
      }
      this.processorProperties.tools = this.userTools.map((tool, idx) => {
         const newTool = new Tool(idx, Color3.FromHexString(tool.color.substring(0, 7)).toColor4(1))
         if (tool.diameter) {
            newTool.diameter = tool.diameter
         }
         return newTool
      })
      this.processorProperties.currentTool = this.processorProperties.tools[0]
   }

   // Last belt-printer settings provided via setZBelt(), re-applied after every loadFile() resets
   // processorProperties - zBelt/gantry angle are parse-time settings baked into ProcessorProperties
   private pendingZBelt: { enabled: boolean; angle: number } | null = null

   setZBelt(enabled: boolean, angle: number) {
      this.pendingZBelt = { enabled, angle }
      this.applyZBelt()
   }

   private applyZBelt() {
      if (!this.pendingZBelt) {
         return
      }
      this.processorProperties.zBelt = this.pendingZBelt.enabled
      this.processorProperties.setGantryAngle(this.pendingZBelt.angle)
      // Previously never reached the WASM parser at all - belt files silently parsed with
      // standard (non-belt) kinematics whenever WASM was enabled
      this.wasmProcessor?.setZBelt(this.pendingZBelt.enabled, this.pendingZBelt.angle)
   }

   // CNC mode - treats every G1 as an extrusion (the "g1AsExtrusion" troubleshooting aid for
   // travel-heavy CNC files). A parse-time setting like zBelt: sticky across loadFile() resets,
   // pushed to the WASM parser too (previously unsettable on either side).
   private pendingCncMode: boolean | null = null

   setG1AsExtrusion(enabled: boolean) {
      this.pendingCncMode = enabled
      this.applyCncMode()
   }

   private applyCncMode() {
      if (this.pendingCncMode === null) {
         return
      }
      this.processorProperties.cncMode = this.pendingCncMode
      this.wasmProcessor?.setCncMode(this.pendingCncMode)
   }

   // Overrides the workplace offset table (G54-G59.3), e.g. synced live from the printer's object
   // model rather than relying on what the loaded file itself sets. Live-applied to the current
   // ProcessorProperties for the gizmo/current position immediately, and remembered so the next
   // loadFile()/reload() starts from these values instead of the parser's [0,0,0] default.
   setWorkplaceOffsets(offsets: { x: number; y: number; z: number }[]) {
      this.pendingWorkplaceOffsets = offsets
      this.applyPendingWorkplace()
   }

   setCurrentWorkplaceIndex(index: number) {
      this.pendingWorkplaceIndex = index
      this.applyPendingWorkplace()
   }

   private applyPendingWorkplace() {
      if (this.pendingWorkplaceOffsets) {
         this.processorProperties.workplaceOffsets = this.pendingWorkplaceOffsets.map(
            (o) => new Vector3(o.x, o.y, o.z),
         )
         // Previously never reached the WASM parser - custom workplace offsets were ignored
         // whenever WASM was enabled, and absolute moves used an all-zero offset table instead
         this.wasmProcessor?.setWorkplaceOffsets(this.pendingWorkplaceOffsets)
      }
      if (this.pendingWorkplaceIndex !== null) {
         this.processorProperties.currentWorkplaceIdx = this.pendingWorkplaceIndex
         this.wasmProcessor?.setCurrentWorkplaceIndex(this.pendingWorkplaceIndex)
      }
   }

   // Current active workplace offset (Babylon space: x, y=height, z), for a consumer's visibility
   // gizmo - null if nothing has ever loaded/synced
   getCurrentWorkplaceOffset(): { x: number; y: number; z: number } | null {
      const wp = this.processorProperties.currentWorkplace
      if (!wp) {
         return null
      }
      return { x: wp.x, y: wp.y, z: wp.z }
   }

   setShowTravels(visible: boolean) {
      this.showTravels = visible
      this.modelMaterial.forEach((m) => m.setShowTravels(visible))
   }

   setPersistTravels(persist: boolean) {
      this.persistTravels = persist
      this.modelMaterial.forEach((m) => m.setPersistTravels(persist))
   }

   // percent: 1-100, the opacity of not-yet-printed lines while alphaMode ("ghosting") is on
   setTransparency(percent: number) {
      this.transparencyPercent = percent
      this.modelMaterial.forEach((m) => m.setTransparency(percent))
   }

   setUseSpecular(enabled: boolean) {
      this.useSpecular = enabled
      this.modelMaterial.forEach((m) => m.setUseSpecular(enabled))
   }

   // Colors are hex strings like '#0000ff'
   setFeedColors(minColor: string, maxColor: string) {
      const min = Color3.FromHexString(minColor.substring(0, 7))
      const max = Color3.FromHexString(maxColor.substring(0, 7))
      this.minFeedColor = [min.r, min.g, min.b]
      this.maxFeedColor = [max.r, max.g, max.b]
      this.modelMaterial.forEach((m) => {
         m.setMinFeedColor(this.minFeedColor)
         m.setMaxFeedColor(this.maxFeedColor)
      })
   }

   // Overrides the feed-rate legend's displayed min/max, independent of the file's actual
   // min/max feed rate (still tracked on processorProperties for loadFile()'s reported result).
   // Pass null for either bound to fall back to the file's own value.
   setFeedRateRange(min: number | null, max: number | null) {
      this.feedRateRangeOverride = min !== null || max !== null ? { min: min ?? 0, max: max ?? 0 } : null
      this.applyFeedRateRange()
   }

   private applyFeedRateRange() {
      const min = this.feedRateRangeOverride?.min ?? this.processorProperties.minFeedRate
      const max = this.feedRateRangeOverride?.max ?? this.processorProperties.maxFeedRate
      this.modelMaterial.forEach((m) => {
         m.setMinFeedRate(min)
         m.setMaxFeedRate(max)
      })
   }

   // Aborts a loadFile() currently in progress - checked between chunks of whichever load loop is
   // running (loadFileStreamed/loadFileStreamedWithPositions/testRenderSceneProgressive). No-op if
   // nothing is loading.
   cancelLoad() {
      this.cancelRequested = true
   }

   private checkCancelled() {
      if (this.cancelRequested) {
         throw new LoadCancelledError()
      }
   }

   // Color4.FromHexString expects an 8-hex-digit (RRGGBBAA) string; pad with full alpha if the
   // caller only supplied RRGGBB, matching Bed.getBedColor4()'s convention elsewhere in this codebase
   setProgressColor(hexColor: string) {
      const color = Color4.FromHexString(hexColor.length >= 9 ? hexColor : hexColor.padEnd(9, 'F'))
      const rgba = [color.r * 255, color.g * 255, color.b * 255, color.a * 255]
      this.modelMaterial.forEach((m) => m.setProgressColor(rgba))
   }

   cleanup() {
      this.gpuPicker?.clearRenderList()
      this.focusedColorId = 0
      this.filePosition = 0
      for (let idx = 0; idx < this.meshes.length; idx++) {
         this.scene.removeMesh(this.meshes[idx], true)
         this.meshes[idx].dispose(false, true)
      }
      this.meshes = []
      this.modelMaterial = []

      // Note: Don't dispose WASM processor here - it should persist across file loads
   }

   dispose() {
      // Clean up WASM processor only when processor itself is disposed
      if (this.wasmProcessor) {
         this.wasmProcessor.dispose()
         this.wasmProcessor = null
      }
   }

   private emptyLoadResult(failed: boolean, cancelled = false): LoadFileResult {
      return { start: 0, end: 0, failed, cancelled, maxHeight: 0, minHeight: 0, maxFeedRate: 0, minFeedRate: 0 }
   }

   async loadFile(file): Promise<LoadFileResult> {
      this.cancelRequested = false
      try {
         return await this.loadFileInner(file)
      } catch (error) {
         const cancelled = error instanceof LoadCancelledError
         // A failure partway through must never leave the UI's progress bar/file state stuck on
         // a half-loaded model (see the gpuPicker-crashes-loadFile class of bug). Resolves rather
         // than rejects - a bad/unparseable file is an expected outcome callers check for, not an
         // exceptional one. A user-requested cancellation is not logged as an error.
         if (!cancelled) {
            console.error('loadFile failed - resetting to an empty, consistent state', error)
         }
         this.worker.postMessage({ type: 'progress', progress: 1, label: 'Processing file' })
         const result = this.emptyLoadResult(!cancelled, cancelled)
         this.worker.postMessage({ type: 'fileloaded', ...result })
         return result
      } finally {
         this.cancelRequested = false
      }
   }

   // Re-processes the currently loaded file with whatever settings are active now (e.g. after
   // toggling a setting that requires a full re-parse). No-ops if nothing has been loaded yet.
   async reload(): Promise<LoadFileResult> {
      if (!this.originalFile) {
         return this.emptyLoadResult(false)
      }
      return await this.loadFile(this.originalFile)
   }

   // Blanks the viewport without loading a new file - distinct from cleanup(), which only tears
   // down meshes/materials as the first step of loadFile(); this also drops the "currently loaded
   // file" state so a subsequent reload() has nothing to reload.
   clear() {
      this.cleanup()
      this.originalFile = undefined
      this.gCodeLines = []
      this.wasmRenderBuffers = null
      this.filePosition = 0
      this.focusedColorId = 0
      this.positionTracker.clear()
      this.sortedPositions = []
      this.worker.postMessage({ type: 'fileloaded', ...this.emptyLoadResult(false) })
   }

   private async loadFileInner(file): Promise<LoadFileResult> {
      this.originalFile = file
      this.cleanup()
      // Buffers from a previous WASM load must not leak into this one, otherwise a TS-parsed file would render the previous file's geometry
      this.wasmRenderBuffers = null
      this.gCodeLines = []
      this.processorProperties = new ProcessorProperties() //Reset for now
      this.processorProperties.slicer = slicerFactory(file)
      this.applyUserTools()
      this.applyZBelt()
      this.applyPendingWorkplace()
      this.applyCncMode()

      // Reset processing stats
      const startTime = performance.now()
      this.processingStats = {
         method: 'none',
         wasmEnabled: this.wasmProcessor !== null,
         wasmVersion: this.wasmProcessor ? await this.getWasmVersion() : undefined,
         linesProcessed: 0,
         movesFound: 0,
         positionsExtracted: 0,
      }

      console.log('Processing file')

      // Try WASM processing first for better performance, fallback to TypeScript
      if (this.wasmProcessor) {
         await this.loadFileWithWasm(file)
      } else {
         console.log('Using TypeScript parser (WASM not enabled)')
         this.lastProcessingMethod = 'typescript'
         this.processingStats.method = 'typescript'
         await this.loadFileStreamed(file)
      }

      // Calculate total processing time
      this.processingStats.totalTime = performance.now() - startTime

      // Send processing complete event with statistics
      this.worker.postMessage({
         type: 'processingComplete',
         stats: this.getProcessingStats(),
      })

      // Log final processing summary
      const totalLines = this.processingStats.linesProcessed || this.gCodeLines.length
      const processingSpeed = totalLines / ((this.processingStats.totalTime || 1) / 1000)
      console.info(
         `📊 Processing Complete: ${this.processingStats.method.toUpperCase()} method, ${totalLines.toLocaleString()} lines in ${(
            this.processingStats.totalTime || 0
         ).toFixed(0)}ms (${Math.round(processingSpeed).toLocaleString()} lines/sec)`,
      )

      console.info('File Loaded.... Rendering Vertices')

      // Check if we have WASM render buffers available
      const wasmBuffers = this.wasmRenderBuffers
      if (wasmBuffers && wasmBuffers.segmentCount > 0) {
         console.log(`🚀 Using WASM render buffers directly for ${wasmBuffers.segmentCount} segments`)
         await this.buildMeshesFromWasmBuffers(wasmBuffers)
      } else {
         console.log('📦 Using traditional progressive rendering')
         await this.testRenderSceneProgressive()
      }

      //This is driving picking
      this.gpuPicker.colorTestCallBack = (colorId) => {
         // Unpicked background reads as (0,0,0) -> colorToNum 0 -> id -1; that's the "nothing
         // hovered" sentinel, not a real line (colorId is 1-indexed against gCodeLines)
         const id = colorToNum(colorId) - 1
         this.focusedColorId = id
         if (id >= 0 && id < this.gCodeLines.length) {
            const o = this.gCodeLines[id]

            this.worker.postMessage({
               type: 'currentline',
               line: o.line,
               lineNumber: o.lineNumber,
               filePosition: o.filePosition,
            })
            this.modelMaterial.forEach((m) => m.setPickColor(colorId))
         }
      }

      this.applyFeedRateRange()
      this.modelMaterial.forEach((m) => {
         m.setMinFeedColor(this.minFeedColor)
         m.setMaxFeedColor(this.maxFeedColor)
         m.setShowTravels(this.showTravels)
         m.setPersistTravels(this.persistTravels)
         m.setTransparency(this.transparencyPercent)
         m.setUseSpecular(this.useSpecular)
      })

      // Empty/unparseable files leave gCodeLines empty - nothing below has a last line to reference
      if (this.gCodeLines.length === 0) {
         const result = this.emptyLoadResult(false)
         this.worker.postMessage({ type: 'fileloaded', ...result })
         return result
      }

      this.modelMaterial.forEach((m) =>
         m.updateCurrentFilePosition(this.gCodeLines[this.gCodeLines.length - 1].filePosition),
      ) //Set it to the end
      this.gpuPicker.updateCurrentPosition(this.gCodeLines[this.gCodeLines.length - 1].filePosition)

      // Ensure we have valid start/end values
      let startByte = this.processorProperties.firstGCodeByte
      let endByte = this.processorProperties.lastGCodeByte

      // Fallback to file bounds if no G-code lines were found
      if (startByte === 0 && endByte === 0 && this.gCodeLines.length > 0) {
         startByte = this.gCodeLines[0].filePosition
         endByte = this.gCodeLines[this.gCodeLines.length - 1].filePosition
      }

      this.worker.postMessage({
         type: 'fileloaded',
         start: startByte,
         end: endByte,
         failed: false,
         cancelled: false,
         maxHeight: this.processorProperties.maxHeight,
         minHeight: this.processorProperties.minHeight,
         maxFeedRate: this.processorProperties.maxFeedRate,
         minFeedRate: this.processorProperties.minFeedRate,
      })

      // Initialize nozzle position to start of print
      if (this.nozzle && this.positionTracker.size > 0) {
         const firstPosition = this.positionTracker.values().next().value
         if (firstPosition) {
            this.nozzle.setPosition({
               x: firstPosition.x,
               y: firstPosition.y,
               z: firstPosition.z,
            })
         }
      }

      this.setMeshMode(this.lastMeshMode)
      return {
         start: startByte,
         end: endByte,
         failed: false,
         cancelled: false,
         maxHeight: this.processorProperties.maxHeight,
         minHeight: this.processorProperties.minHeight,
         maxFeedRate: this.processorProperties.maxFeedRate,
         minFeedRate: this.processorProperties.minFeedRate,
      }
   }

   private async loadFileStreamed(file: string) {
      const chunkSize = 10000 // Process 10k lines at a time
      let pos = 0

      // Track TypeScript processing if not already set
      if (this.lastProcessingMethod === 'none') {
         this.lastProcessingMethod = 'typescript'
         this.processingStats.method = 'typescript'
      }

      // Estimate line count for pre-allocation (average ~40 chars per line)
      const estimatedLines = Math.ceil(file.length / 40)

      this.gCodeLines = [] // Start with empty array, will grow as needed

      // Clear position tracker for new file
      this.positionTracker.clear()
      this.sortedPositions = []

      // Reset progress tracking
      this.lastReportedProgress = 0
      this.lastReportedChunk = 0

      // Pre-allocate position tracking arrays
      let estimatedMoves = Math.ceil(estimatedLines * 0.7) // ~70% of lines are moves
      let tempPositions: number[] = new Array(estimatedMoves)
      let tempPositionData: Array<{ x: number; y: number; z: number; feedRate: number; extruding: boolean }> =
         new Array(estimatedMoves)
      let positionCount = 0

      // Stream through file character by character instead of split('\n')
      const lines = this.streamLines(file)

      for (let chunkStart = 0; chunkStart < lines.length; chunkStart += chunkSize) {
         const chunkEnd = Math.min(chunkStart + chunkSize, lines.length)

         // Process chunk
         for (let idx = chunkStart; idx < chunkEnd; idx++) {
            const line = lines[idx]
            this.processorProperties.lineNumber = idx + 1 //Use one index to match file
            this.processorProperties.filePosition = pos
            pos += line.length + 1 //Account for newlines that have been stripped

            const gcodeLine = ProcessLine(this.processorProperties, line)
            this.gCodeLines.push(gcodeLine)

            // Batch store position data for nozzle tracking. Includes travels ('T'), not just
            // extruding moves ('L') - matches the WASM/Rust parser, which tracks both; previously
            // only extruding moves were tracked here, so nozzle scrubbing skipped over travel
            // moves when WASM was disabled but followed them when it was enabled.
            if (gcodeLine.lineType === 'L' || gcodeLine.lineType === 'T') {
               const move = gcodeLine as Move
               if (move.end && Array.isArray(move.end) && move.end.length >= 3) {
                  // Expand arrays if we exceed initial estimate
                  if (positionCount >= estimatedMoves) {
                     const newSize = Math.ceil(estimatedMoves * 1.5)
                     const newPositions = new Array(newSize)
                     const newData = new Array(newSize)

                     // Copy existing data
                     for (let i = 0; i < positionCount; i++) {
                        newPositions[i] = tempPositions[i]
                        newData[i] = tempPositionData[i]
                     }

                     tempPositions = newPositions
                     tempPositionData = newData
                     estimatedMoves = newSize
                     console.log('Expanded position arrays to', newSize, 'entries')
                  }

                  tempPositions[positionCount] = move.filePosition
                  tempPositionData[positionCount] = {
                     x: move.end[0],
                     y: move.end[1],
                     z: move.end[2],
                     feedRate: move.feedRate || 1500,
                     extruding: move.extruding,
                  }
                  positionCount++
               }
            }
         }

         // Report progress less frequently (every 2% or every 50k lines)
         const progress = chunkEnd / lines.length
         if (progress - this.lastReportedProgress >= 0.02 || chunkEnd - this.lastReportedChunk >= 50000) {
            this.worker.postMessage({
               type: 'progress',
               progress: progress,
               label: 'Processing file',
            })
            this.lastReportedProgress = progress
            this.lastReportedChunk = chunkEnd
         }

         // Yield control to prevent blocking UI
         if (chunkEnd < lines.length) {
            await new Promise((resolve) => setTimeout(resolve, 0))
            this.checkCancelled()
         }
      }

      this.worker.postMessage({ type: 'progress', progress: 1, label: 'Processing file' })

      // Batch transfer position data to final data structures
      console.log('Transferring', positionCount, 'positions to tracker')

      // Pre-allocate final arrays with actual count
      this.sortedPositions = new Array(positionCount)

      for (let i = 0; i < positionCount; i++) {
         const filePos = tempPositions[i]
         this.positionTracker.set(filePos, tempPositionData[i])
         this.sortedPositions[i] = filePos
      }

      // Sort positions for sequential playback (more efficient on pre-allocated array)
      this.sortedPositions.sort((a, b) => a - b)
   }

   private async loadFileWithWasm(file: string) {
      console.log('🚀 Using WASM parser for fast processing')

      try {
         const wasmStartTime = performance.now()

         // Process file with WASM for position extraction and basic analysis. Returning
         // this.cancelRequested lets a cancelLoad() call interrupt the parse loop *inside* the
         // single synchronous WASM call, rather than only being detectable once it returns -
         // previously cancelLoad() had no way to interrupt WASM parsing itself, however long it ran.
         const result = await this.wasmProcessor!.processFile(file, (progress: number, label: string) => {
            this.worker.postMessage({
               type: 'progress',
               progress: progress,
               label: `WASM: ${label}`,
            })
            return this.cancelRequested
         })

         const wasmEndTime = performance.now()
         this.processingStats.wasmTime = wasmEndTime - wasmStartTime

         if (result.cancelled) {
            throw new LoadCancelledError()
         }
         this.checkCancelled()

         if (!result.success) {
            console.warn('❌ WASM processing failed, falling back to TypeScript parser:', result.errorMessage)
            this.lastProcessingMethod = 'typescript'
            this.processingStats.method = 'typescript-fallback'
            await this.loadFileStreamed(file)
            return
         }

         const linesPerSecond = Math.round(result.lineCount / (result.processingTimeMs / 1000))
         console.log(
            `✅ WASM processed ${result.lineCount.toLocaleString()} lines with ${result.moveCount.toLocaleString()} moves in ${
               result.processingTimeMs
            }ms (${linesPerSecond.toLocaleString()} lines/sec)`,
         )

         // Update processing statistics
         this.processingStats.linesProcessed = result.lineCount
         this.processingStats.movesFound = result.moveCount
         this.lastProcessingMethod = 'hybrid'
         this.processingStats.method = 'hybrid'

         // Get position data from WASM
         const sortedPositions = this.wasmProcessor!.getSortedPositions()
         this.positionTracker.clear()
         this.sortedPositions = Array.from(sortedPositions)
         this.processingStats.positionsExtracted = sortedPositions.length

         // Build position tracker from WASM data
         for (const pos of sortedPositions) {
            const posData = this.wasmProcessor!.getPositionData(pos)
            if (posData) {
               this.positionTracker.set(pos, posData)
            }
         }

         // Generate render buffers using WASM for maximum speed
         console.log('🚀 Generating render buffers with WASM...')

         try {
            const wasmRenderBuffers = this.wasmProcessor!.generateRenderBuffers(0.4, 0.2, this.perimeterOnly, (progress: number, label: string) => {
               this.worker.postMessage({
                  type: 'progress',
                  progress: progress,
                  label: label,
               })
            })
            //const renderTime = performance.now() - renderStartTime
            //console.log(`✅ WASM generated ${wasmRenderBuffers.segmentCount.toFixed(2)} render segments in ${renderTime.toFixed(2)}ms`)

            // Store render buffers for mesh creation
            this.wasmRenderBuffers = wasmRenderBuffers
            // this.processingStats.wasmRenderTime = renderTime
            this.processingStats.renderSegmentsGenerated = wasmRenderBuffers.segmentCount
            this.checkCancelled()

            // gCodeLines still needs line-indexed placeholders for GPU-picking readback,
            // getGCodeInRange and updateByLineNumber - but since WASM already parsed every move
            // and rendering came straight from its buffers, there's no need to re-run the full
            // TS G-code parser (arc math, extrusion tracking, tool/workplace state, slicer feature
            // detection) a second time just to reconstruct real Move/ArcMove objects nothing else
            // reads. Aggregate stats (height/feed-rate bounds, print bounds, first/last G-code
            // byte) come directly from the WASM result instead of being recomputed too.
            console.log('🔧 Building lightweight line index from WASM data...')
            const compatStartTime = performance.now()

            this.processorProperties = new ProcessorProperties()
            this.applyUserTools()
            this.applyPendingWorkplace()
            this.processorProperties.maxHeight = result.maxHeight
            this.processorProperties.minHeight = result.minHeight
            this.processorProperties.maxFeedRate = result.maxFeedRate
            this.processorProperties.minFeedRate = result.minFeedRate
            this.processorProperties.firstGCodeByte = result.firstGCodeByte
            this.processorProperties.lastGCodeByte = result.lastGCodeByte
            this.processorProperties.printBoundsMinX = result.printBoundsMinX
            this.processorProperties.printBoundsMinY = result.printBoundsMinY
            this.processorProperties.printBoundsMinZ = result.printBoundsMinZ
            this.processorProperties.printBoundsMaxX = result.printBoundsMaxX
            this.processorProperties.printBoundsMaxY = result.printBoundsMaxY
            this.processorProperties.printBoundsMaxZ = result.printBoundsMaxZ

            await this.buildLightweightGCodeLines(file)
            const compatTime = performance.now() - compatStartTime
            console.log(`🔧 Lightweight line index built in ${compatTime.toFixed(2)}ms`)
         } catch (error) {
            if (error instanceof LoadCancelledError) {
               throw error
            }
            console.error('❌ WASM render buffer generation failed:', error)
            console.warn('🔄 Using TypeScript fallback for rendering...')
            // Fallback to TypeScript rendering
            const tsStartTime = performance.now()
            console.log('🔧 Building TypeScript G-code objects for rendering...')

            // Reset processor state for TypeScript parsing phase
            this.processorProperties = new ProcessorProperties()
            this.processorProperties.slicer = slicerFactory(file)
            this.applyUserTools()
            this.applyZBelt()
            this.applyCncMode()

            await this.loadFileStreamedWithPositions(file)
            this.processingStats.typescriptTime = performance.now() - tsStartTime
         }

         // Report final performance comparison
         const totalWasmTime = (this.processingStats.wasmTime || 0) + (this.processingStats.typescriptTime || 0)
         const efficiency = this.processingStats.wasmTime
            ? Math.round((this.processingStats.wasmTime / totalWasmTime) * 100)
            : 0
         console.log(`🎯 Hybrid processing complete - WASM: ${efficiency}%, TypeScript: ${100 - efficiency}%`)
      } catch (error) {
         if (error instanceof LoadCancelledError) {
            throw error
         }
         console.error('💥 WASM processing error, falling back to TypeScript parser:', error)
         this.lastProcessingMethod = 'typescript'
         this.processingStats.method = 'typescript-fallback'
         await this.loadFileStreamed(file)
      }
   }

   // Builds gCodeLines[] straight from WASM's already-extracted per-move data (this.positionTracker,
   // populated by the caller just before this runs) instead of running the file back through the
   // real G-code parser. A line's presence in positionTracker (keyed by its own file byte
   // position) is enough to know it's a move and whether it's extruding or a travel - no semantic
   // parsing needed for the classification itself, and no other IndexEntry field needs one either.
   private async buildLightweightGCodeLines(file: string) {
      const chunkSize = 10000
      const lines = this.streamLines(file)
      this.gCodeLines = new Array(lines.length)

      this.lastReportedProgress = 0
      this.lastReportedChunk = 0

      let pos = 0
      for (let chunkStart = 0; chunkStart < lines.length; chunkStart += chunkSize) {
         const chunkEnd = Math.min(chunkStart + chunkSize, lines.length)

         for (let idx = chunkStart; idx < chunkEnd; idx++) {
            const line = lines[idx]
            this.processorProperties.lineNumber = idx + 1
            this.processorProperties.filePosition = pos
            pos += line.length + 1

            const posData = this.positionTracker.get(this.processorProperties.filePosition)
            let lineType: string
            if (posData) {
               lineType = posData.extruding ? 'L' : 'T'
            } else {
               const trimmed = line.trim()
               if (trimmed.length === 0 || trimmed.startsWith(';')) {
                  lineType = 'C'
               } else {
                  const first = trimmed[0].toUpperCase()
                  lineType = first === 'M' ? 'M' : first === 'G' || first === 'T' ? 'G' : 'C'
               }
            }

            this.gCodeLines[idx] = new IndexEntry(this.processorProperties, line, lineType)
         }

         const progress = chunkEnd / lines.length
         if (progress - this.lastReportedProgress >= 0.02 || chunkEnd - this.lastReportedChunk >= 50000) {
            this.worker.postMessage({ type: 'progress', progress: progress, label: 'Building index' })
            this.lastReportedProgress = progress
            this.lastReportedChunk = chunkEnd
         }

         if (chunkEnd < lines.length) {
            await new Promise((resolve) => setTimeout(resolve, 0))
            this.checkCancelled()
         }
      }
   }

   private async loadFileStreamedWithPositions(file: string) {
      // Lightweight version of loadFileStreamed that leverages WASM position data
      const chunkSize = 10000
      let pos = 0

      const lines = this.streamLines(file)

      // Reset processor properties for TypeScript processing
      this.processorProperties.lineNumber = 0
      this.processorProperties.filePosition = 0

      for (let chunkStart = 0; chunkStart < lines.length; chunkStart += chunkSize) {
         const chunkEnd = Math.min(chunkStart + chunkSize, lines.length)

         // Process chunk with error handling
         for (let idx = chunkStart; idx < chunkEnd; idx++) {
            try {
               const line = lines[idx]
               this.processorProperties.lineNumber = idx + 1
               this.processorProperties.filePosition = pos
               pos += line.length + 1

               // Skip temperature commands that aren't visualized (M104, M109, M140, M190, etc.)
               const trimmedLine = line.trim().toUpperCase()
               if (
                  trimmedLine.startsWith('M104') ||
                  trimmedLine.startsWith('M109') ||
                  trimmedLine.startsWith('M140') ||
                  trimmedLine.startsWith('M190') ||
                  trimmedLine.startsWith('M155')
               ) {
                  // Create a simple comment object for temperature commands to maintain line count
                  const gcodeLine = ProcessLine(this.processorProperties, ';' + line)
                  this.gCodeLines.push(gcodeLine)
                  continue
               }

               const gcodeLine = ProcessLine(this.processorProperties, line)
               this.gCodeLines.push(gcodeLine)
            } catch (error) {
               console.error(`Error processing line ${idx + 1}: "${lines[idx]}"`, error)
               // Continue processing other lines
            }
         }

         // Report progress less frequently
         const progress = chunkEnd / lines.length
         if (progress - this.lastReportedProgress >= 0.02 || chunkEnd - this.lastReportedChunk >= 50000) {
            this.worker.postMessage({
               type: 'progress',
               progress: progress,
               label: 'Building render objects',
            })
            this.lastReportedProgress = progress
            this.lastReportedChunk = chunkEnd
         }

         // Yield control
         if (chunkEnd < lines.length) {
            await new Promise((resolve) => setTimeout(resolve, 0))
            this.checkCancelled()
         }
      }
   }

   addNewMaterial(isLineMesh: boolean = false): LineShaderMaterial {
      const m = new LineShaderMaterial(this.scene, isLineMesh)
      this.modelMaterial.push(m)
      return m
   }

   async testRenderSceneProgressive() {
      const renderlines = []
      let segmentCount = 0
      let lastRenderedIdx = 0
      let alphaIndex = 0

      for (let idx = 0; idx < this.gCodeLines.length; idx++) {
         const gCodeline = this.gCodeLines[idx] as Move
         // Only move/arc/travel lines carry a meaningful isPerimeter flag - comments and
         // commands don't, so applying this filter to them would wrap every one of them in a
         // Move_Thin (which expects Move/ArcMove-shaped data) for no reason
         const isMoveLine = gCodeline.lineType === 'L' || gCodeline.lineType === 'A' || gCodeline.lineType === 'T'
         if (isMoveLine && this.perimeterOnly && !gCodeline.isPerimeter) {
            this.gCodeLines[idx] = new Move_Thin(this.processorProperties, gCodeline as Move, null, idx)
            continue
         }
         try {
            if (gCodeline.lineType === 'L' && gCodeline.extruding) {
               //Regular move
               renderlines.push(gCodeline)
               segmentCount++
            } else if (gCodeline.lineType === 'A' && gCodeline.extruding) {
               //Arc Move
               renderlines.push(gCodeline)
               segmentCount += (this.gCodeLines[idx] as ArcMove).segments.length
            } else if (gCodeline.lineType === 'T') {
               //Travel
               renderlines.push(gCodeline)
               segmentCount++
            }
         } catch (ex) {
            console.log(this.gCodeLines[idx], ex)
         }

         if (segmentCount >= this.breakPoint) {
            alphaIndex++

            const sl = renderlines.slice(lastRenderedIdx)
            const rl = this.testBuildMesh(sl, segmentCount, alphaIndex)
            this.meshes.push(...rl)
            lastRenderedIdx = renderlines.length
            segmentCount = 0

            this.worker.postMessage({
               type: 'progress',
               progress: idx / this.gCodeLines.length,
               label: 'Generating model.',
            })

            // Yield control every few mesh generations
            if (alphaIndex % 5 === 0) {
               await new Promise((resolve) => setTimeout(resolve, 0))
               this.checkCancelled()
            }
         }
      }

      if (segmentCount > 0) {
         const sl = renderlines.slice(lastRenderedIdx)
         const rl = this.testBuildMesh(sl, segmentCount, alphaIndex)
         this.meshes.push(...rl)
      }

      this.worker.postMessage({
         type: 'progress',
         progress: 1,
         label: 'Generating model.',
      })

      this.modelMaterial.forEach((m) => {
         m.updateCurrentFilePosition(this.filePosition)
         m.updateToolColors(this.processorProperties.buildToolFloat32Array())
      })
   }

   // 0 = Box
   // 1 = cyl
   // 2 = line
   setMeshMode(mode) {
      // this.scene.unfreezeActiveMeshes()
      mode = mode > 2 ? 0 : mode
      this.meshes.forEach((m) => m.setEnabled(false))
      const activeMeshes: Mesh[] = []
      for (let idx = mode; idx < this.meshes.length; idx += 3) {
         this.meshes[idx].setEnabled(true)
         activeMeshes.push(this.meshes[idx])
      }
      this.lastMeshMode = mode

      // Picking always targets whichever mesh variant is currently visible (they all carry
      // identical per-instance filePosition/pickColor/tool attributes), so it doesn't need its
      // own always-enabled shadow copy of the box meshes
      this.gpuPicker?.setActiveMeshes(activeMeshes)
   }

   testBuildMesh(renderlines, segCount, alphaIndex): Mesh[] {
      const box = MeshBuilder.CreateBox('box', { width: 1, height: 1, depth: 1 }, this.scene)
      box.position = new Vector3(0, 0, 0)
      box.rotate(Axis.X, Math.PI / 4, Space.LOCAL)
      box.bakeCurrentTransformIntoVertices()
      //box.convertToUnIndexedMesh()

      const cyl = MeshBuilder.CreateCylinder('cyl', { height: 1, diameter: 1 }, this.scene)
      cyl.locallyTranslate(new Vector3(0, 0, 0))
      cyl.rotate(new Vector3(0, 0, 1), Math.PI / 2, Space.WORLD)
      cyl.bakeCurrentTransformIntoVertices()

      const line = MeshBuilder.CreateLines(
         'line',
         {
            points: [new Vector3(-0.5, 0, 0), new Vector3(0.5, 0, 0)],
         },
         this.scene,
      )

      const matrixData = new Float32Array(16 * segCount)
      const colorData = new Float32Array(4 * segCount)
      const pickData = new Float32Array(3 * segCount)
      const filePositionData = new Float32Array(segCount)
      const fileEndPositionData = new Float32Array(segCount)
      const toolData = new Float32Array(segCount)
      const feedRate = new Float32Array(segCount)
      const isPerimeter = new Float32Array(segCount)

      box.material = this.addNewMaterial().material
      box.alphaIndex = alphaIndex
      //box.material.freeze()

      cyl.material = this.addNewMaterial().material
      cyl.alphaIndex = alphaIndex
      //cyl.material.freeze()

      const mm = this.addNewMaterial(true)
      line.alphaIndex = alphaIndex
      line.material = mm.material
      //line.material.freeze()

      //  box.name = `Mesh${this.meshes.length}}`

      let segIdx = 0
      for (let idx = 0; idx < renderlines.length; idx++) {
         const line = renderlines[idx] as Base
         if (line.lineType === 'L' || line.lineType === 'T') {
            const l = line as Move
            const lineData = l.renderLine(0.4, 0.2)
            buildBuffers(lineData, l, segIdx)
            this.gCodeLines[line.lineNumber - 1] = new Move_Thin(this.processorProperties, line as Move, box, idx) //remove unnecessary information now that we have the matrix
            segIdx++
         } else if (line.lineType === 'A') {
            const arc = line as ArcMove
            //run all the segments
            for (const seg in arc.segments) {
               const segment = arc.segments[seg] as Move
               const lineData = segment.renderLine(0.38, 0.3)
               buildBuffers(lineData, arc, segIdx)
               segIdx++
            }
            this.gCodeLines[line.lineNumber - 1] = new Move_Thin(this.processorProperties, line as ArcMove, box, idx) //remove unnecessary information now that we have the matrix
         }
      }

      copyBuffers(box)
      copyBuffers(cyl)
      cyl.setEnabled(false)
      copyBuffers(line)
      line.setEnabled(false)

      return [box, cyl, line]

      function copyBuffers(m: Mesh) {
         //let matrixDataClone = Float32Array.from(matrixData) //new Float32Array(matrixData)
         m.thinInstanceSetBuffer('matrix', matrixData, 16, true)
         m.doNotSyncBoundingInfo = true
         m.thinInstanceRefreshBoundingInfo(false)
         m.thinInstanceSetBuffer('baseColor', colorData, 4, true)
         m.thinInstanceSetBuffer('pickColor', pickData, 3, true) //this holds the color ids for the mesh
         m.thinInstanceSetBuffer('filePosition', filePositionData, 1, true)
         m.thinInstanceSetBuffer('filePositionEnd', fileEndPositionData, 1, true)
         m.thinInstanceSetBuffer('tool', toolData, 1, true)
         m.thinInstanceSetBuffer('feedRate', feedRate, 1, true)
         m.thinInstanceSetBuffer('isPerimeter', isPerimeter, 1, true)
         //         m.freezeWorldMatrix()
         m.isPickable = false
      }

      //Inner function with access to buffers
      function buildBuffers(lineData: MoveData, line: ArcMove | Move, idx: number) {
         lineData.Matrix.copyToArray(matrixData, idx * 16)
         colorData.set(lineData.Color, idx * 4)
         pickData.set([line.colorId[0] / 255, line.colorId[1] / 255, line.colorId[2] / 255], idx * 3)
         filePositionData.set([line.filePosition], idx) //Record the file position with the mesh
         fileEndPositionData.set([line.filePosition + line.line.length], idx) //Record the file position with the mesh
         toolData.set([line.tool], idx)
         feedRate.set([line.feedRate], idx)
         isPerimeter.set([line.isPerimeter ? 1 : 0], idx)
      }
   }

   getFileSize() {
      if (this.gCodeLines && this.gCodeLines.length > 0) {
         return this.gCodeLines[this.gCodeLines.length - 1].filePosition
      }
      return 0
   }

   getGCodeInRange(filePos, count = 20) {
      if (this.gCodeLines.length === 0) {
         this.worker.postMessage({ type: 'getgcodes', lines: [] })
         return
      }

      let idx = binarySearchClosest(this.gCodeLines, filePos, 'filePosition')

      if (this.gCodeLines[idx].filePosition > filePos) idx--

      let min = Math.max(0, idx - count / 2)
      let max = Math.min(idx + count / 2, this.gCodeLines.length - 1)

      if (count % 2 == 1) {
         min++
         max++
      }

      const sub = this.gCodeLines.slice(min, max)
      const lines = []
      for (const idx in sub) {
         const l = sub[idx]
         lines.push({
            line: l.line,
            lineNumber: l.lineNumber,
            filePosition: l.filePosition,
            lineType: l.lineType,
            focus: false,
         })
      }

      const f = lines.find((f) => f.lineNumber == this.gCodeLines[idx].lineNumber)
      if (f) f.focus = true

      this.worker.postMessage({ type: 'getgcodes', lines: lines })
   }

   updateFilePosition(position: number, animate: boolean = false) {
      this.filePosition = position // Store the current position
      this.modelMaterial.forEach((m) => m.updateCurrentFilePosition(position)) //Set it to the end
      this.gpuPicker.updateCurrentPosition(position)

      // Update nozzle position based on G-code position
      if (this.nozzle && this.positionTracker.size > 0) {
         if (this.isPlaying && !animate) {
            // Manual position change during animation - skip to position and continue playing
            this.skipToPosition(position)
         } else if (!this.isPlaying) {
            // Normal position update when not playing
            if (animate) {
               this.updateNozzlePositionAnimated(position)
            } else {
               this.updateNozzlePositionInstant(position)
            }
         }
         // If animate is true and playing, let the animation continue naturally
      }
   }

   private updateNozzlePositionInstant(filePosition: number) {
      if (!this.nozzle || this.positionTracker.size === 0) return

      // Binary search via the already-sorted positions instead of scanning every tracked
      // position - matters on multi-million-line files where scrubbing the timeline was
      // otherwise an O(n) scan per position update
      const idx = this.findClosestPositionIndex(filePosition)
      const closestPosition = this.positionTracker.get(this.sortedPositions[idx])

      if (closestPosition) {
         this.nozzle.setPosition({
            x: closestPosition.x,
            y: closestPosition.y,
            z: closestPosition.z,
         })
      }
   }

   private updateNozzlePositionAnimated(filePosition: number) {
      if (!this.nozzle || this.positionTracker.size === 0) return

      const idx = this.findClosestPositionIndex(filePosition)
      const closestPosition = this.positionTracker.get(this.sortedPositions[idx])

      if (closestPosition) {
         // Create a fake Move object for the nozzle animation
         const fakeMove = {
            end: [closestPosition.x, closestPosition.y, closestPosition.z],
            feedRate: closestPosition.feedRate,
            extruding: closestPosition.extruding,
         }

         // Create movement and animate to it
         const movement = this.nozzle.createMovementFromGCode(fakeMove as any, this.nozzle.getCurrentPosition())
         this.nozzle.moveToPosition(movement)
      }
   }

   async animateNozzleToPosition(targetPosition: number): Promise<void> {
      if (!this.nozzle || this.gCodeLines.length === 0) return

      const currentIdx = binarySearchClosest(this.gCodeLines, this.filePosition, 'filePosition')
      const targetIdx = binarySearchClosest(this.gCodeLines, targetPosition, 'filePosition')

      // Animate through moves between current and target position
      const startIdx = Math.min(currentIdx, targetIdx)
      const endIdx = Math.max(currentIdx, targetIdx)

      for (let i = startIdx; i <= endIdx; i++) {
         const gcodeLine = this.gCodeLines[i]
         if (gcodeLine && gcodeLine.lineType === 'L') {
            const move = gcodeLine as Move
            const movement = this.nozzle.createMovementFromGCode(move, this.nozzle.getCurrentPosition())
            await this.nozzle.moveToPosition(movement)
         }
      }
   }

   updateByLineNumber(lineNumber: number) {
      this.updateFilePosition(this.gCodeLines[lineNumber - 1].filePosition)
   }

   private async buildMeshesFromWasmBuffers(wasmBuffers: any) {
      console.log('🔧 Building meshes directly from WASM render buffers...')
      const startTime = performance.now()

      // Create single mesh set from WASM buffers
      const meshes = this.createMeshesFromWasmBuffers(wasmBuffers)

      this.meshes.push(...meshes)
      // Picking's active mesh set is (re)established by the setMeshMode(this.lastMeshMode) call
      // at the end of loadFile, once every mesh chunk (TS or WASM) has been created

      // Update materials
      this.modelMaterial.forEach((m) => {
         m.updateCurrentFilePosition(this.filePosition)
         m.updateToolColors(this.processorProperties.buildToolFloat32Array())
      })

      this.worker.postMessage({
         type: 'progress',
         progress: 1,
         label: 'Generating model.',
      })

      const buildTime = performance.now() - startTime
      console.log(
         `✅ WASM mesh building completed in ${buildTime.toFixed(2)}ms for ${wasmBuffers.segmentCount} segments`,
      )
   }

   private createMeshesFromWasmBuffers(wasmBuffers: any): Mesh[] {
      // Create box mesh
      const box = MeshBuilder.CreateBox('box', { width: 1, height: 1, depth: 1 }, this.scene)
      box.position = new Vector3(0, 0, 0)
      box.rotate(Axis.X, Math.PI / 4, Space.LOCAL)
      box.bakeCurrentTransformIntoVertices()

      // Create cylinder mesh
      const cyl = MeshBuilder.CreateCylinder('cyl', { height: 1, diameter: 1 }, this.scene)
      cyl.locallyTranslate(new Vector3(0, 0, 0))
      cyl.rotate(new Vector3(0, 0, 1), Math.PI / 2, Space.WORLD)
      cyl.bakeCurrentTransformIntoVertices()

      // Create line mesh
      const line = MeshBuilder.CreateLines(
         'line',
         {
            points: [new Vector3(-0.5, 0, 0), new Vector3(0.5, 0, 0)],
         },
         this.scene,
      )

      // Assign materials and alpha index
      const alphaIndex = 0
      box.material = this.addNewMaterial().material
      box.alphaIndex = alphaIndex

      cyl.material = this.addNewMaterial().material
      cyl.alphaIndex = alphaIndex

      const mm = this.addNewMaterial(true)
      line.alphaIndex = alphaIndex
      line.material = mm.material

      // Apply WASM buffers directly to all meshes
      this.applyWasmBuffersToMesh(box, wasmBuffers)
      this.applyWasmBuffersToMesh(cyl, wasmBuffers)
      this.applyWasmBuffersToMesh(line, wasmBuffers)

      return [box, cyl, line]
   }

   private applyWasmBuffersToMesh(mesh: Mesh, wasmBuffers: any) {
      // Apply WASM-generated buffer data directly to mesh. Mirrors testBuildMesh's copyBuffers()
      // exactly (static buffers + refreshed bounding info) - without this the mesh keeps the unit
      // bounding box from its base geometry and gets frustum-culled away at most camera angles
      // despite the thin instances rendering far outside it.
      mesh.thinInstanceSetBuffer('matrix', wasmBuffers.matrixData, 16, true)
      mesh.doNotSyncBoundingInfo = true
      mesh.thinInstanceRefreshBoundingInfo(false)

      mesh.thinInstanceSetBuffer('baseColor', wasmBuffers.colorData, 4, true)
      mesh.thinInstanceSetBuffer('pickColor', wasmBuffers.pickData, 3, true)
      mesh.thinInstanceSetBuffer('filePosition', wasmBuffers.filePositionData, 1, true)
      mesh.thinInstanceSetBuffer('filePositionEnd', wasmBuffers.fileEndPositionData, 1, true)
      mesh.thinInstanceSetBuffer('tool', wasmBuffers.toolData, 1, true)
      mesh.thinInstanceSetBuffer('feedRate', wasmBuffers.feedRateData, 1, true)
      mesh.thinInstanceSetBuffer('isPerimeter', wasmBuffers.isPerimeterData, 1, true)
      mesh.isPickable = false

      console.log(`📊 Applied WASM buffers to ${mesh.name}: ${wasmBuffers.segmentCount} instances`)
   }

   // Parse/build-time filter (affects which segments get built into the mesh at all, not just a
   // shader-level visibility toggle) - sticky across reload like zBelt/cncMode/workplace, applied
   // whenever the caller next reloads. Previously triggered its own internal reload here, which
   // both duplicated whatever reload the caller was already about to do and gave the caller no way
   // to know when it finished to restore the current file position afterward (DWC had no watcher
   // wired to this at all, since there was nothing it could safely await).
   setPerimeterOnly(perimeterOnly: boolean) {
      this.perimeterOnly = perimeterOnly
   }

   showSupports(show) {
      this.modelMaterial.forEach((m) => m.showSupports(show))
   }

   // Animation control methods
   startNozzleAnimation(): void {
      if (!this.nozzle || this.sortedPositions.length === 0) {
         console.warn('Cannot start animation: nozzle or positions not available')
         return
      }

      if (this.isPlaying) {
         console.log('Animation already playing, continuing from current position')
         return
      }

      console.log('Starting animation from current file position:', this.filePosition)

      this.isPlaying = true

      // Notify UI that animation started
      this.worker.postMessage({
         type: 'animationStarted',
         currentPosition: this.getCurrentAnimationIndex(),
         totalPositions: this.sortedPositions.length,
      })

      // Start immediately without await to prevent blocking
      this.animateToNextPosition()
   }

   pauseNozzleAnimation(): void {
      if (!this.isPlaying) {
         console.log('Animation not playing, nothing to pause')
         return
      }

      this.isPlaying = false

      if (this.playbackTimeout) {
         clearTimeout(this.playbackTimeout)
         this.playbackTimeout = null
      }

      if (this.nozzle) {
         this.nozzle.stopAnimation()
      }

      // Notify UI that animation paused
      this.worker.postMessage({
         type: 'animationPaused',
         currentPosition: this.getCurrentAnimationIndex(),
         totalPositions: this.sortedPositions.length,
      })
   }

   resumeNozzleAnimation(): void {
      if (this.isPlaying) {
         console.log('Animation already playing')
         return
      }

      if (!this.nozzle || this.sortedPositions.length === 0) {
         console.warn('Cannot resume animation: nozzle or positions not available')
         return
      }

      this.isPlaying = true

      // Notify UI that animation resumed
      this.worker.postMessage({
         type: 'animationResumed',
         currentPosition: this.getCurrentAnimationIndex(),
         totalPositions: this.sortedPositions.length,
      })

      // Continue from current position
      this.animateToNextPosition()
   }

   stopNozzleAnimation(): void {
      this.isPlaying = false

      if (this.playbackTimeout) {
         clearTimeout(this.playbackTimeout)
         this.playbackTimeout = null
      }

      if (this.nozzle) {
         this.nozzle.stopAnimation()
      }

      // Notify UI that animation stopped
      this.worker.postMessage({
         type: 'animationStopped',
      })
   }

   private animateToNextPosition(): void {
      if (!this.isPlaying || !this.nozzle) {
         return
      }

      const currentIndex = this.getCurrentAnimationIndex()
      const nextIndex = currentIndex + 1

      if (nextIndex >= this.sortedPositions.length) {
         this.stopNozzleAnimation()
         return
      }

      const nextFilePosition = this.sortedPositions[nextIndex]
      const positionData = this.positionTracker.get(nextFilePosition)

      if (positionData) {
         // Update file position to match animation progress - but don't trigger position change events
         this.filePosition = nextFilePosition
         this.modelMaterial.forEach((m) => m.updateCurrentFilePosition(nextFilePosition))
         this.gpuPicker.updateCurrentPosition(nextFilePosition)

         // Notify UI of position change
         this.worker.postMessage({
            type: 'animationPositionUpdate',
            position: nextFilePosition,
            progress: nextIndex / this.sortedPositions.length,
         })

         // Create movement for nozzle
         const fakeMove = {
            end: [positionData.x, positionData.y, positionData.z],
            feedRate: positionData.feedRate,
            extruding: positionData.extruding,
         }

         try {
            const movement = this.nozzle.createMovementFromGCode(fakeMove as any, this.nozzle.getCurrentPosition())

            // Use the actual calculated duration from nozzle movement instead of fixed delay
            this.nozzle
               .moveToPosition(movement)
               .then(() => {
                  if (this.isPlaying) {
                     // Use minimal delay - nozzle animation duration handles timing
                     this.playbackTimeout = window.setTimeout(() => {
                        this.animateToNextPosition()
                     }, 10)
                  }
               })
               .catch(() => {
                  if (this.isPlaying) {
                     this.playbackTimeout = window.setTimeout(() => {
                        this.animateToNextPosition()
                     }, 10)
                  }
               })
         } catch {
            if (this.isPlaying) {
               this.playbackTimeout = window.setTimeout(() => {
                  this.animateToNextPosition()
               }, 10)
            }
         }
      } else {
         if (this.isPlaying) {
            this.playbackTimeout = window.setTimeout(() => {
               this.animateToNextPosition()
            }, 10)
         }
      }
   }

   isNozzleAnimationPlaying(): boolean {
      return this.isPlaying
   }

   private getCurrentAnimationIndex(): number {
      return this.findClosestPositionIndex(this.filePosition)
   }

   private skipToPosition(targetFilePosition: number): void {
      if (!this.nozzle || this.sortedPositions.length === 0) {
         return
      }

      // Clear any existing timeout first
      if (this.playbackTimeout) {
         clearTimeout(this.playbackTimeout)
         this.playbackTimeout = null
      }

      // Stop current animation
      this.nozzle.stopAnimation()

      // Update file position - this is now the single source of truth
      this.filePosition = targetFilePosition

      // Find the closest position data for the nozzle
      const targetIndex = this.findClosestPositionIndex(targetFilePosition)
      if (targetIndex >= 0 && targetIndex < this.sortedPositions.length) {
         const positionData = this.positionTracker.get(this.sortedPositions[targetIndex])
         if (positionData) {
            // Set nozzle to the target position immediately
            this.nozzle.setPosition({
               x: positionData.x,
               y: positionData.y,
               z: positionData.z,
            })
         }
      }

      // Continue animation from this point if still playing
      if (this.isPlaying) {
         // Small delay before continuing to allow position to settle
         this.playbackTimeout = window.setTimeout(() => {
            this.animateToNextPosition()
         }, 150)
      }
   }

   private streamLines(file: string): string[] {
      // Fast line splitting without creating intermediate arrays
      const lines: string[] = []
      let start = 0

      for (let i = 0; i < file.length; i++) {
         if (file[i] === '\n') {
            lines.push(file.substring(start, i))
            start = i + 1
         }
      }

      // Handle last line if no trailing newline
      if (start < file.length) {
         lines.push(file.substring(start))
      }

      return lines
   }

   private findClosestPositionIndex(targetFilePosition: number): number {
      let left = 0
      let right = this.sortedPositions.length - 1
      let closestIndex = 0
      let minDistance = Infinity

      // Binary search for efficiency, then linear refinement for closest match
      while (left <= right) {
         const mid = Math.floor((left + right) / 2)
         const distance = Math.abs(this.sortedPositions[mid] - targetFilePosition)

         if (distance < minDistance) {
            minDistance = distance
            closestIndex = mid
         }

         if (this.sortedPositions[mid] < targetFilePosition) {
            left = mid + 1
         } else {
            right = mid - 1
         }
      }

      return closestIndex
   }
}
