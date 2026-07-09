import { Scene } from '@babylonjs/core/scene'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { Vector3, Quaternion } from '@babylonjs/core/Maths/math.vector'
import { makeTextPlane } from './textplane'
import { BuildVolume } from './bed'

// Small numeric tick labels along the front (gcode X) and left (gcode Y) edges of the bed, so a
// user can gauge where a loaded part actually sits on the bed at a glance - previously the grid
// had no scale reference at all. Flat on the bed plane (like the grid itself), not billboarded:
// readable from the default top-down/oblique views this viewer is normally used from.
export default class Ruler {
   private scene: Scene
   private labels: Mesh[] = []
   registerClipIgnore: (mesh: Mesh) => void = () => {}

   constructor(scene: Scene) {
      this.scene = scene
   }

   // A "nice" tick interval (1/2/5 x a power of ten) targeting roughly 4-6 ticks across the
   // larger axis - fewer, bigger labels read far better at the zoom level a whole bed is
   // normally viewed at than the denser spacing a graph axis would use
   private static niceInterval(span: number): number {
      if (!Number.isFinite(span) || span <= 0) {
         return 10
      }
      const roughStep = span / 5
      const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)))
      const residual = roughStep / magnitude
      let niceResidual: number
      if (residual < 1.5) niceResidual = 1
      else if (residual < 3.5) niceResidual = 2
      else if (residual < 7.5) niceResidual = 5
      else niceResidual = 10
      return niceResidual * magnitude
   }

   private formatTick(value: number): string {
      const rounded = Math.round(value * 100) / 100
      return Number.isInteger(rounded) ? rounded.toString() : rounded.toFixed(2)
   }

   // gcodeX/gcodeY here are gcode-space mm (this class's own inputs/outputs), converted to
   // Babylon space (x=gcode X, y=height, z=gcode Y) only at the point of mesh placement
   private addLabel(text: string, gcodeX: number, gcodeY: number, size: number) {
      // makeTextPlane's 2nd argument is both the displayed text AND (via its templated mesh name)
      // the mesh identity - reusing it for a unique mesh name too was rendering the whole
      // "ruler-<text>-<x>-<y>" debug-ish string onto the label itself instead of just the tick
      // value. Rename the mesh separately afterward instead.
      const plane = makeTextPlane(this.scene, text, 'white', '#000000', size, size * 0.6, 100)
      plane.name = `ruler-${text}-${gcodeX}-${gcodeY}`
      plane.rotationQuaternion = Quaternion.RotationAxis(new Vector3(1, 0, 0), Math.PI / 2)
      plane.position = new Vector3(gcodeX, 0.1, gcodeY)
      plane.isPickable = false
      this.registerClipIgnore(plane)
      this.labels.push(plane)
   }

   build(volume: BuildVolume): void {
      this.dispose()

      const sizeX = volume.x.max - volume.x.min
      const sizeY = volume.y.max - volume.y.min
      const interval = Ruler.niceInterval(Math.max(sizeX, sizeY))
      if (!Number.isFinite(interval) || interval <= 0) {
         return
      }

      // Sized off the bed's overall span, not the tick interval - a whole bed is normally framed
      // to fill most of the viewport, so this keeps labels legible regardless of tick density
      const labelSize = Math.min(Math.max(Math.max(sizeX, sizeY) * 0.08, 6), 28)
      const margin = labelSize * 0.9

      // X-axis ticks along the front edge (gcode Y = min), labelling gcode X positions
      const firstX = Math.ceil(volume.x.min / interval) * interval
      for (let x = firstX; x <= volume.x.max + 1e-6; x += interval) {
         this.addLabel(this.formatTick(x), x, volume.y.min - margin, labelSize)
      }

      // Y-axis ticks along the left edge (gcode X = min), labelling gcode Y positions - skip the
      // origin tick already placed by the X loop above
      const firstY = Math.ceil(volume.y.min / interval) * interval
      for (let y = firstY; y <= volume.y.max + 1e-6; y += interval) {
         if (Math.abs(y - volume.y.min) < 1e-6) {
            continue
         }
         this.addLabel(this.formatTick(y), volume.x.min - margin, y, labelSize)
      }
   }

   show(visible: boolean): void {
      this.labels.forEach((l) => l.setEnabled(visible))
   }

   dispose(): void {
      this.labels.forEach((l) => l.dispose())
      this.labels = []
   }
}
