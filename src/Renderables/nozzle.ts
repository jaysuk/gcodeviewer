import { Scene } from '@babylonjs/core/scene'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { Tween, Easing, Group } from '@tweenjs/tween.js'
import type { Move } from '../GCodeLines'

export interface NozzlePosition {
   x: number
   y: number
   z: number
}

export interface NozzleMovement {
   startPos: NozzlePosition
   endPos: NozzlePosition
   feedRate: number // mm/min
   duration: number // calculated duration in milliseconds
   isExtruding: boolean
}

export default class Nozzle {
   private scene: Scene
   private nozzleGroup: TransformNode
   private nozzleTip: Mesh
   private nozzleBody: Mesh
   private hotEnd: Mesh
   private material: StandardMaterial
   private hotEndMaterial: StandardMaterial
   
   // Configuration
   nozzleDiameter: number = 0.4 // Default nozzle diameter in mm
   nozzleColor: Color3 = new Color3(0.8, 0.3, 0.1) // Orange/copper color
   hotEndColor: Color3 = new Color3(0.2, 0.2, 0.2) // Dark gray
   
   // State
   private isVisible: boolean = false
   private currentPosition: NozzlePosition = { x: 0, y: 0, z: 0 }
   private currentTween: Tween<NozzlePosition> | null = null
   private isAnimating: boolean = false
   
   // Animation settings
   private animationSpeed: number = 1.0 // Speed multiplier for animations
   private tweenGroup: Group = new Group()

   constructor(scene: Scene, diameter: number = 0.4) {
      this.scene = scene
      this.nozzleDiameter = diameter
      this.createNozzleGeometry()
      this.setupMaterial()
      this.hide() // Start hidden
   }

   private createNozzleGeometry(): void {
      // Create a transform node to group all nozzle components
      this.nozzleGroup = new TransformNode('nozzleGroup', this.scene)

      // Create nozzle tip (cone shape)
      this.nozzleTip = MeshBuilder.CreateCylinder('nozzleTip', {
         height: 3,
         diameterTop: this.nozzleDiameter * 2,
         diameterBottom: this.nozzleDiameter * 0.5,
         tessellation: 16
      }, this.scene)
      this.nozzleTip.parent = this.nozzleGroup

      // Create nozzle body (cylinder)
      this.nozzleBody = MeshBuilder.CreateCylinder('nozzleBody', {
         height: 8,
         diameter: this.nozzleDiameter * 3,
         tessellation: 16
      }, this.scene)
      this.nozzleBody.position.y = 5.5 // Position above tip
      this.nozzleBody.parent = this.nozzleGroup

      // Create hot end block (box)
      this.hotEnd = MeshBuilder.CreateBox('hotEnd', {
         width: 15,
         height: 10,
         depth: 12
      }, this.scene)
      this.hotEnd.position.y = 15 // Position above body
      this.hotEnd.parent = this.nozzleGroup

      // Rotate entire assembly so tip points down
      this.nozzleGroup.rotation.x = 0
      this.nozzleGroup.rotation.y = 0
      this.nozzleGroup.rotation.z = 0
   }

   private setupMaterial(): void {
      // Create material for nozzle components
      this.material = new StandardMaterial('nozzleMaterial', this.scene)
      this.material.diffuseColor = this.nozzleColor
      this.material.specularColor = new Color3(0.5, 0.5, 0.5)
      this.material.roughness = 0.3

      // Apply materials
      this.nozzleTip.material = this.material
      this.nozzleBody.material = this.material

      // Hot end gets different material
      this.hotEndMaterial = new StandardMaterial('hotEndMaterial', this.scene)
      this.hotEndMaterial.diffuseColor = this.hotEndColor
      this.hotEndMaterial.specularColor = new Color3(0.2, 0.2, 0.2)
      this.hotEndMaterial.roughness = 0.8
      this.hotEnd.material = this.hotEndMaterial
   }

   setDiameter(diameter: number): void {
      this.nozzleDiameter = diameter
      // Recreate geometry with new diameter
      this.dispose()
      this.createNozzleGeometry()
      this.setupMaterial()
      if (!this.isVisible) {
         this.hide()
      }
   }

   setColor(color: Color3): void {
      this.nozzleColor = color
      if (this.material) {
         this.material.diffuseColor = color
      }
   }

   show(): void {
      this.isVisible = true
      if (this.nozzleGroup) {
         this.nozzleGroup.setEnabled(true)
      }
   }

   hide(): void {
      this.isVisible = false
      if (this.nozzleGroup) {
         this.nozzleGroup.setEnabled(false)
      }
   }

   toggle(): void {
      if (this.isVisible) {
         this.hide()
      } else {
         this.show()
      }
   }

   isNozzleVisible(): boolean {
      return this.isVisible
   }

   setPosition(position: NozzlePosition): void {
      this.currentPosition = { ...position }
      if (this.nozzleGroup) {
         this.nozzleGroup.position = new Vector3(position.x, position.y + 2, position.z)
      }
   }

   getCurrentPosition(): NozzlePosition {
      return { ...this.currentPosition }
   }

   /**
    * Calculate movement duration based on feedrate
    * @param movement The movement to calculate duration for
    * @returns Duration in milliseconds
    */
   private calculateMovementDuration(movement: NozzleMovement): number {
      const distance = Math.sqrt(
         Math.pow(movement.endPos.x - movement.startPos.x, 2) +
         Math.pow(movement.endPos.y - movement.startPos.y, 2) +
         Math.pow(movement.endPos.z - movement.startPos.z, 2)
      )
      
      if (distance === 0) {
         return 100 // Default short duration for zero-distance moves
      }
      
      if (movement.feedRate === 0) {
         return 500 // Default duration when no feedrate
      }

      // Calculate realistic duration based on feedrate and animation speed multiplier
      const realDurationMs = (distance / movement.feedRate) * 60000 // Convert mm/min to ms
      const scaledDuration = realDurationMs / this.animationSpeed
      
      // Clamp to reasonable bounds for visualization
      const finalDuration = Math.max(50, Math.min(scaledDuration, 3000))
      
      return finalDuration
   }

   /**
    * Create a movement from a G-code Move object
    */
   createMovementFromGCode(move: Move, startPos: NozzlePosition): NozzleMovement {
      const movement = {
         startPos,
         endPos: {
            x: move.end[0],
            y: move.end[1], 
            z: move.end[2]
         },
         feedRate: move.feedRate || 1500, // Default feedrate if not specified
         duration: 0, // Will be calculated
         isExtruding: move.extruding
      }
      
      return movement
   }

   /**
    * Animate nozzle movement with tweening
    */
   async moveToPosition(movement: NozzleMovement): Promise<void> {
      if (!this.isVisible) {
         // If not visible, just update position instantly
         this.setPosition(movement.endPos)
         return Promise.resolve()
      }

      // Stop any existing animation
      this.stopAnimation()

      const duration = this.calculateMovementDuration(movement)
      
      return new Promise<void>((resolve, reject) => {
         try {
            // Create a copy of the current position for TWEEN to modify
            const tweenObject = { ...this.currentPosition }
            
            this.currentTween = new Tween(tweenObject, this.tweenGroup)
               .to(movement.endPos, duration)
               .easing(movement.isExtruding ? Easing.Linear.None : Easing.Quadratic.InOut)
               .onUpdate(() => {
                  if (this.nozzleGroup) {
                     const newPos = new Vector3(tweenObject.x, tweenObject.y + 2, tweenObject.z)
                     this.nozzleGroup.position.copyFrom(newPos)
                     // Force update current position for tracking
                     this.currentPosition = { ...tweenObject }
                  }
               })
               .onComplete(() => {
                  this.currentTween = null
                  this.isAnimating = false
                  this.currentPosition = { ...movement.endPos }
                  resolve()
               })
               .onStop(() => {
                  this.currentTween = null
                  this.isAnimating = false
                  resolve()
               })
               .start()

            this.isAnimating = true
         } catch (error) {
            this.currentTween = null
            this.isAnimating = false
            reject(error)
         }
      })
   }

   /**
    * Stop current animation
    */
   stopAnimation(): void {
      if (this.currentTween) {
         this.currentTween.stop()
         this.currentTween = null
      }
      this.isAnimating = false
   }

   /**
    * Force position update (for skipping during animation)
    */
   forcePosition(position: NozzlePosition): void {
      this.stopAnimation()
      this.setPosition(position)
   }

   /**
    * Set animation speed multiplier
    */
   setAnimationSpeed(speed: number): void {
      this.animationSpeed = Math.max(0.1, Math.min(speed, 10.0))
   }

   getAnimationSpeed(): number {
      return this.animationSpeed
   }

   isCurrentlyAnimating(): boolean {
      return this.isAnimating
   }

   /**
    * Update tweens (call this in render loop)
    */
   update(): void {
      this.tweenGroup.update()
   }

   /**
    * Clean up resources
    */
   dispose(): void {
      this.stopAnimation()
      
      if (this.nozzleTip) {
         this.nozzleTip.dispose()
      }
      if (this.nozzleBody) {
         this.nozzleBody.dispose()
      }
      if (this.hotEnd) {
         this.hotEnd.dispose()
      }
      if (this.nozzleGroup) {
         this.nozzleGroup.dispose()
      }
      if (this.material) {
         this.material.dispose()
      }
      if (this.hotEndMaterial) {
         this.hotEndMaterial.dispose()
      }
   }

   getDiameter(): number {
      return this.nozzleDiameter
   }

   toString(): string {
      return `Nozzle Diameter: ${this.nozzleDiameter} mm, Position: (${this.currentPosition.x.toFixed(2)}, ${this.currentPosition.y.toFixed(2)}, ${this.currentPosition.z.toFixed(2)}), Visible: ${this.isVisible}`
   }
}
