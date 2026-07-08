import { LoadFileResult } from './processor'

// The consumer-facing surface shared by ViewerProxy (worker-backed) and ViewerDirect
// (same-thread). Both classes `implements` this so tsc catches API drift between them at
// compile time instead of it only surfacing when a consumer swaps which one they import.
export default interface ViewerApi {
   passThru: any

   init(): void
   loadFile(file: any): Promise<LoadFileResult>
   reload(): Promise<LoadFileResult>
   clear(): Promise<void>
   unload(): void
   resize(): void
   updateFilePosition(filePosition: number, animate?: boolean): void
   getGCodes(position: number, count: number): void
   goToLineNumber(lineNumber: number): void
   setAlphaMode(mode: boolean): void
   setProgressMode(mode: boolean): void
   setRenderMode(mode: number): void
   setMaxFPS(fps: number): void
   setMeshMode(mode: number): void
   setPerimeterOnly(perimeterOnly: boolean): void
   setPickingEnabled(enabled: boolean): void
   showViewBox(visible: boolean): void
   setCameraDirection(direction: { x: number; y: number; z: number }): void
   resetCamera(): void
   frameToContent(isEmbedded: boolean): void
   setBackgroundColor(color: string): void
   setProgressColor(color: string): void
   setZBelt(enabled: boolean, angle: number): void
   setG1AsExtrusion(enabled: boolean): void
   setCameraInertia(enabled: boolean): void
   setZClipPlane(top: number, bottom: number): void
   setTools(tools: { color: string; diameter?: number }[]): void
   setBuildVolume(volume: { x: { min: number; max: number }; y: { min: number; max: number }; z: { min: number; max: number } }): void
   setBedRenderMode(mode: number): void
   setBedColor(color: string): void
   setDeltaBed(isDelta: boolean): void
   showBed(visible: boolean): void
   showAxes(visible: boolean): void
   showWorkplace(visible: boolean): void
   setWorkplaceOffsets(offsets: { x: number; y: number; z: number }[]): void
   setCurrentWorkplaceIndex(index: number): void
   setNozzlePosition(position: { x: number; y: number; z: number }): void
   setShowTravels(visible: boolean): void
   setPersistTravels(persist: boolean): void
   setFeedColors(minColor: string, maxColor: string): void
   setFeedRateRange(min: number | null, max: number | null): void
   cancelLoad(): void
   loadObjectBoundaries(objects: any[]): void
   showObjectSelection(visible: boolean): void
   showObjectLabels(visible: boolean): void
   toggleNozzle(visible: boolean): void
   startNozzleAnimation(): void
   pauseNozzleAnimation(): void
   resumeNozzleAnimation(): void
   stopNozzleAnimation(): void
   setNozzleAnimationSpeed(speed: number): void
   enableWasmProcessing(): Promise<void>
   getProcessingStats(): Promise<any>
}
