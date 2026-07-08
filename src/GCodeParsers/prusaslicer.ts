import ProcessorProperties from '../processorproperties'
import SlicerBase from './slicerbase'

export default class PrusaSlicer extends SlicerBase {
   featureList = {
      PERIMETER: { color: [1, 0.9, 0.3, 1], perimeter: true, support: false },
      'EXTERNAL PERIMETER': { color: [1, 0.5, 0.2, 1], perimeter: true, support: false },
      'INTERNAL INFILL': { color: [0.59, 0.19, 0.16, 1], perimeter: false, support: false },
      'SOLID INFILL': { color: [0.59, 0.19, 0.8, 1], perimeter: false, support: false },
      'TOP SOLID INFILL': { color: [0.95, 0.25, 0.25, 1], perimeter: false, support: false },
      'BRIDGE INFILL': { color: [0.3, 0.5, 0.73, 1], perimeter: false, support: false },
      'GAP FILL': { color: [1, 1, 1, 1], perimeter: false, support: false },
      SKIRT: { color: [0, 0.53, 0.43, 1], perimeter: false, support: false },
      'SKIRT/BRIM': { color: [0, 0.53, 0.43, 1], perimeter: false, support: false },
      'SUPPORTED MATERIAL': { color: [0, 1, 0, 1], perimeter: false, support: true },
      'SUPPORTED MATERIAL INTERFACE': { color: [0, 0.5, 0, 1], perimeter: false, support: true },
      CUSTOM: { color: [0.5, 0.5, 0.5, 1], perimeter: false, support: false },
      UNKNOWN: { color: [0.5, 0.5, 0.5, 1], perimeter: false, support: false },

      //Look up colors
      'SUPPORT MATERIAL': { color: [0.5, 0.5, 0.5, 1], perimeter: false, support: true },
      'SUPPORT MATERIAL INTERFACE': { color: [0.5, 0.5, 0.5, 1], perimeter: false, support: true },
      'OVERHANG PERIMETER': { color: [0.5, 0.5, 0.5, 1], perimeter: true, support: false },
      'WIPE TOWER': { color: [0.5, 0.5, 0.5, 1], perimeter: false, support: false },
   }

   constructor() {
      super()
      console.info('Prusa Slicer detected')
   }

   processComment(comment: string) {
      if (comment.startsWith(';TYPE:')) {
         this.feature = comment.substring(6).trim()
         // Normalize: uppercase and collapse/harmonize separators
         const key = this.feature
            .toUpperCase()
            .replace(/[-_]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()

         // Try direct lookup
         let feature = this.featureList[key]

         // Heuristics for known synonyms/variants
         if (!feature) {
            if (key.includes('TOP') && key.includes('SOLID') && key.includes('INFILL')) {
               feature = this.featureList['TOP SOLID INFILL']
            } else if (key.includes('SOLID') && key.includes('INFILL')) {
               feature = this.featureList['SOLID INFILL']
            } else if (key.includes('BRIDGE') && key.includes('INFILL')) {
               feature = this.featureList['BRIDGE INFILL']
            } else if (key.includes('GAP') && key.includes('FILL')) {
               feature = this.featureList['GAP FILL']
            } else if (key.includes('EXTERNAL') && key.includes('PERIMETER')) {
               feature = this.featureList['EXTERNAL PERIMETER']
            } else if (key.includes('INTERNAL') && key.includes('INFILL')) {
               feature = this.featureList['INTERNAL INFILL']
            } else if (key.includes('SUPPORT') && key.includes('INTERFACE')) {
               feature = this.featureList['SUPPORT MATERIAL INTERFACE']
                  || this.featureList['SUPPORTED MATERIAL INTERFACE']
            } else if (key.includes('SUPPORT')) {
               feature = this.featureList['SUPPORT MATERIAL']
                  || this.featureList['SUPPORTED MATERIAL']
            } else if (key.includes('SKIRT') || key.includes('BRIM')) {
               feature = this.featureList['SKIRT/BRIM'] || this.featureList['SKIRT']
            }
         }

         if (feature) {
            this.currentFeatureColor = feature.color
            this.currentIsPerimeter = feature.perimeter
            this.currentIsSupport = feature.support
         } else {
            this.reportMissingFeature(this.feature)
            this.currentFeatureColor = [1, 1, 1, 1]
            this.currentIsPerimeter = true
            this.currentIsSupport = false
         }
      }
   }

   getFeatureColor(): number[] {
      return this.currentFeatureColor
   }

   isPerimeter(): boolean {
      return this.currentIsPerimeter
   }

   isSupport(): boolean {
      return this.currentIsSupport
   }

   processHeader(file: string[], props: ProcessorProperties) {
      try {
         for (let lineIdx = file.length - 350; lineIdx < file.length - 1; lineIdx++) {
            const line = file[lineIdx]

            //Pull out the nozzle diameter for each tool
            if (line.includes('nozzle_diameter')) {
               const equalSign = line.indexOf('=') + 1
               const diameters = line.substring(equalSign).split(',')
               for (let toolIdx = 0; toolIdx < diameters.length; toolIdx++) {
                  if (toolIdx < props.tools.length) {
                     props.tools[toolIdx].diameter = Number(diameters[toolIdx])
                  }
               }
            }
         }
      } catch (e) {
         console.error(e)
      }
   }
}
