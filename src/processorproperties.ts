import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import Tool, { createDefaultTools } from './tools'
import { Color4 } from '@babylonjs/core/Maths/math.color'
import SlicerBase from './GCodeParsers/slicerbase'
import GenericBase from './GCodeParsers/genericbase'

export enum ColorMode {
   Tool,
   Feature,
   FeedRate,
}

export enum ArcPlane {
   XY = 'XY',
   XZ = 'XZ',
   YZ = 'YZ',
}

export enum Units {
   millimeters = 'mm',
   inches = 'in',
}

//This is the class that holds all the properties that are used by the processor
export default class ProcessorProperties {
   maxHeight: number = 0
   minHeight: number = 0
   // Bounding box (Babylon space: x, y=height, z) over EXTRUDING moves only - distinct from
   // maxHeight/minHeight above (which track every move, extruding or not, for Z-clip slider
   // bounds). Drives camera-framing: "fit the actual print", not "fit everywhere the head went".
   printBoundsMinX: number = Infinity
   printBoundsMinY: number = Infinity
   printBoundsMinZ: number = Infinity
   printBoundsMaxX: number = -Infinity
   printBoundsMaxY: number = -Infinity
   printBoundsMaxZ: number = -Infinity
   lineCount: number = 0
   layerDictionary: [] = []
   previousZ: number = 0 //Last Z value where extrusion occured  - This may need to go away to depend on slicer especially for non-planar prints
   filePosition: number = 0
   lineNumber: number = 0
   tools: Tool[] = []
   currentTool: Tool
   currentPosition: Vector3 = new Vector3(0, 0, 0)
   currentFeedRate: number = 1
   maxFeedRate: number = 1
   minFeedRate: number = 999999999
   progressColor: Color4 = new Color4(0, 1, 0, 1)
   progressAnimation: boolean = true //Formerly known as "renderAnimation"
   firstGCodeByte: number = 0
   lastGCodeByte: number = 0
   hasMixing: boolean = false
   currentWorkplaceIdx: number = 0
   workplaceOffsets: Vector3[] = []
   absolute: boolean = true // G-code spec default (matches WASM's absolute_positioning default) - files that never issue G90 still parse correctly
   firmwareRetraction: boolean = false
   units = Units.millimeters
   totalRenderedSegments: number = 0
   fixRadius: boolean = false // Used to fix a radius on an arc if it's too small. Some CNC processors "fix" G2/G3 for you
   arcPlane: ArcPlane = ArcPlane.XY // Used to determine the plane of an arc
   cncMode: boolean = false
   spindleSpeed: number = 0
   spindleOn: boolean = false
   bedLevelingActive: boolean = false
   extruderAbsolute: boolean = true
   slicer: SlicerBase = new GenericBase()

   //Used for belt processing
   zBelt: boolean = false
   zBeltLength: number = 100
   gantryAngle = (45 * Math.PI) / 180
   currentZ = 0
   hyp = Math.cos(this.gantryAngle)
   adj = Math.tan(this.gantryAngle)

   setGantryAngle(angle: number) {
      this.gantryAngle = (angle * Math.PI) / 180
      this.hyp = Math.cos(this.gantryAngle)
      this.adj = Math.tan(this.gantryAngle)
   }

   get CurrentFeedRate(): number {
      return this.currentFeedRate
   }

   set CurrentFeedRate(value: number) {
      // Fold the incoming value into min/max, not the value being replaced - otherwise the last
      // feed rate ever set is never accounted for, and the first real value is compared against
      // the initial default of 1 instead of being the new baseline
      if (value > this.maxFeedRate) {
         this.maxFeedRate = value
      }
      if (value != 0 && value < this.minFeedRate) {
         this.minFeedRate = value
      }

      this.currentFeedRate = value
   }

   get currentWorkplace() {
      return this.workplaceOffsets[this.currentWorkplaceIdx]
   }

   // Matches the Rust/WASM parser's update_height() (called for every move, extruding or not) -
   // previously only tracked on the WASM side, leaving maxHeight/minHeight permanently at their
   // 0/0 defaults (and any consumer relying on them, e.g. BuildObjects' cancel-object overlay
   // sizing) wrong whenever a file went through the pure-TypeScript parser.
   updateHeight(z: number) {
      if (z > this.maxHeight) {
         this.maxHeight = z
      }
      if (z < this.minHeight) {
         this.minHeight = z
      }
   }

   // Only called for extruding moves - see printBoundsMin/Max above
   updatePrintBounds(x: number, y: number, z: number) {
      if (x < this.printBoundsMinX) this.printBoundsMinX = x
      if (x > this.printBoundsMaxX) this.printBoundsMaxX = x
      if (y < this.printBoundsMinY) this.printBoundsMinY = y
      if (y > this.printBoundsMaxY) this.printBoundsMaxY = y
      if (z < this.printBoundsMinZ) this.printBoundsMinZ = z
      if (z > this.printBoundsMaxZ) this.printBoundsMaxZ = z
   }

   buildToolFloat32Array() {
      const toolArray = new Array(this.tools.length * 4)
      for (let idx = 0; idx < this.tools.length; idx++) {
         this.tools[idx].color.toArray(toolArray, idx * 4)
      }
      return toolArray
   }

   constructor() {
      this.workplaceOffsets.push(new Vector3(0, 0, 0)) //set a default workplace if we do not have workplaces
      this.tools = createDefaultTools() // fresh array per instance - never shared/mutated across instances
      this.currentTool = this.tools[0]
   }
}
