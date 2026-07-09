import { Scene } from '@babylonjs/core/scene'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { Vector3, Quaternion } from '@babylonjs/core/Maths/math.vector'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { Space } from '@babylonjs/core/Maths/math.axis'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { HighlightLayer } from '@babylonjs/core/Layers/highlightLayer'
import { GridMaterial } from '@babylonjs/materials/grid/gridMaterial'

export enum RenderBedMode {
   bed = 0,
   box = 1
}

export interface AxisRange {
   min: number
   max: number
}

export interface BuildVolume {
   x: AxisRange
   y: AxisRange
   z: AxisRange
}

export default class Bed {
   buildVolume: BuildVolume = {
      x: { min: 0, max: 100 },
      y: { min: 0, max: 100 },
      z: { min: 0, max: 100 }
   }

   renderMode: RenderBedMode = RenderBedMode.bed
   isDelta = false
   debug = false
   registerClipIgnore: (mesh: Mesh) => void = () => {}

   private scene: Scene
   private bedMesh: Mesh = null
   private bedLineColor = '#0000FF'
   private planeMaterial: GridMaterial
   private boxMaterial: StandardMaterial
   private highlightLayer: HighlightLayer = null

   constructor(scene: Scene) {
      this.scene = scene
      this.planeMaterial = this.buildGridMaterial()
      this.boxMaterial = new StandardMaterial('bedBoxMaterial', this.scene)
      this.boxMaterial.alpha = 0
   }

   setRenderMode(renderBedMode: RenderBedMode): void {
      this.renderMode = renderBedMode
      this.dispose()
      this.buildBed()
      this.scene.render()
   }

   buildBed(): Mesh {
      if (this.debug) {
         return null
      }
      if (this.bedMesh && this.bedMesh.isDisposed()) {
         this.bedMesh = null
      }
      if (this.bedMesh) {
         return this.bedMesh
      }

      switch (this.renderMode) {
         case RenderBedMode.bed:
            this.buildFlatBed()
            break
         case RenderBedMode.box:
            this.buildBox()
            break
      }
      return this.bedMesh
   }

   setDelta(isDelta: boolean): void {
      this.isDelta = isDelta
      this.setRenderMode(this.renderMode)
   }

   buildFlatBed(): void {
      const bedCenter = this.getCenter()
      const bedSize = this.getSize()
      if (this.isDelta) {
         const radius = Math.abs(this.buildVolume.x.max - this.buildVolume.x.min) / 2
         this.bedMesh = MeshBuilder.CreateDisc('BuildPlate', { radius: radius }, this.scene)
         this.bedMesh.rotationQuaternion = Quaternion.RotationAxis(new Vector3(1, 0, 0), Math.PI / 2)
         this.bedMesh.material = this.planeMaterial
      } else {
         this.bedMesh = MeshBuilder.CreatePlane('BuildPlate', { width: bedSize.x, height: bedSize.y }, this.scene)
         this.bedMesh.material = this.planeMaterial
         this.bedMesh.rotationQuaternion = Quaternion.RotationAxis(new Vector3(1, 0, 0), Math.PI / 2)
         this.bedMesh.translate(new Vector3(bedCenter.x, 0, bedCenter.y), 1, Space.WORLD)
      }
      this.registerClipIgnore(this.bedMesh)
   }

   getCenter(): { x: number, y: number, z: number } {
      return {
         x: (this.buildVolume.x.max + this.buildVolume.x.min) / 2,
         y: (this.buildVolume.y.max + this.buildVolume.y.min) / 2,
         z: (this.buildVolume.z.max + this.buildVolume.z.min) / 2
      }
   }

   getSize(): { x: number, y: number, z: number } {
      return {
         x: Math.abs(this.buildVolume.x.max - this.buildVolume.x.min),
         y: Math.abs(this.buildVolume.y.max - this.buildVolume.y.min),
         z: Math.abs(this.buildVolume.z.max - this.buildVolume.z.min)
      }
   }

   buildBox(): void {
      const bedSize = this.getSize()
      const bedCenter = this.getCenter()
      if (this.isDelta) {
         this.bedMesh = MeshBuilder.CreateCylinder('bed', {
            diameterTop: bedSize.x,
            diameterBottom: bedSize.x,
            height: bedSize.z
         }, this.scene)
         this.bedMesh.position.x = bedCenter.x
         this.bedMesh.position.y = bedCenter.z
         this.bedMesh.position.z = bedCenter.y
         this.bedMesh.isPickable = false
         this.bedMesh.enableEdgesRendering(undefined, true)

         // Render only the stroked outline of the cylinder: the highlight layer draws the silhouette while
         // color writes are disabled for the mesh itself so its faces stay invisible
         this.bedMesh.renderingGroupId = 2
         this.scene.setRenderingAutoClearDepthStencil(2, false, false, false)

         this.highlightLayer = new HighlightLayer('hl', this.scene, { isStroke: true, blurTextureSizeRatio: 3 })
         this.highlightLayer.addMesh(this.bedMesh, Color3.FromHexString(this.getBedColor()))

         this.bedMesh.onBeforeRenderObservable.add(() => {
            this.scene.getEngine().setColorWrite(false)
         })

         this.bedMesh.onAfterRenderObservable.add(() => {
            this.scene.getEngine().setColorWrite(true)
         })

         this.registerClipIgnore(this.bedMesh)
      } else {
         this.bedMesh = MeshBuilder.CreateBox('bed', {
            width: bedSize.x,
            depth: bedSize.y,
            height: bedSize.z
         }, this.scene)
         // CreateBox is centered at its local origin (matches CreatePlane in buildFlatBed, which
         // positions at bedCenter directly) - the extra "- min" here shifted the box off-center
         // for any printer whose build volume doesn't start at 0 (e.g. center-origin CoreXY)
         this.bedMesh.position.x = bedCenter.x
         this.bedMesh.position.y = bedCenter.z
         this.bedMesh.position.z = bedCenter.y
         this.bedMesh.enableEdgesRendering()
         this.bedMesh.edgesWidth = 100
         this.bedMesh.material = this.boxMaterial
         this.bedMesh.isPickable = false
         this.bedMesh.edgesColor = this.getBedColor4()

         this.registerClipIgnore(this.bedMesh)
      }
   }

   setVisibility(visibility: boolean): void {
      if (this.bedMesh) {
         this.bedMesh.setEnabled(visibility)
      }
   }

   commitBedSize(): void {
      this.setRenderMode(this.renderMode)
   }

   buildGridMaterial(): GridMaterial {
      const gridMaterial = new GridMaterial('bedMaterial', this.scene)
      gridMaterial.mainColor = new Color3(0, 0, 0)
      gridMaterial.lineColor = Color3.FromHexString(this.getBedColor())
      gridMaterial.gridRatio = 5
      gridMaterial.opacity = 0.8
      gridMaterial.majorUnitFrequency = 10
      gridMaterial.minorUnitVisibility = 0.6
      gridMaterial.gridOffset = new Vector3(0, 0, 0)
      // CreatePlane makes a single-sided mesh - without this the grid vanished entirely once the
      // camera looked up at its back face (e.g. rotating to view from underneath the bed)
      gridMaterial.backFaceCulling = false
      return gridMaterial
   }

   getBedColor(): string {
      return this.bedLineColor
   }

   setBedColor(color: string): void {
      this.bedLineColor = color
      this.planeMaterial.dispose()
      this.planeMaterial = this.buildGridMaterial()
      this.dispose()
      this.buildBed()
      this.scene.render()
   }

   getBedColor4(): Color4 {
      return Color4.FromHexString(this.getBedColor().padEnd(9, 'F'))
   }

   // Called routinely (setRenderMode/commitBedSize/setDelta) to tear down the current mesh before
   // rebuilding it - must never dispose planeMaterial/boxMaterial (shared, reused by buildBed()),
   // or the next build assigns an already-disposed material and renders broken/invisible. The
   // scene's own disposal (Viewer.unload -> engine.dispose()) reaps these materials at final teardown.
   dispose(): void {
      if (this.bedMesh) {
         this.bedMesh.dispose(false, false)
         this.bedMesh = null
      }
      if (this.highlightLayer) {
         this.highlightLayer.dispose()
         this.highlightLayer = null
      }
   }
}
