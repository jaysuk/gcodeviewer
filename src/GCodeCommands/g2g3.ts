import { ArcMove, Base, Move } from '../GCodeLines'
import Props from '../processorproperties'
import { doArc } from '../util'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'

const tokenList = /(?=[GXYZIJKFRE])/

//Reminder Add G53 check

export default function (props: Props, line: string): Base {
   const move = new ArcMove(props, line)

   // Strip any inline comment before tokenizing - otherwise a comment word starting with one of
   // the token letters (e.g. "; Edge case") corrupts tokenization and would be mistaken for a
   // parameter, including a false extrusion match on a stray 'E'
   const commentIdx = line.indexOf(';')
   const codeLine = commentIdx >= 0 ? line.substring(0, commentIdx) : line

   const tokens = codeLine.split(tokenList)

   const eToken = tokens.find((t) => t[0] === 'E' || t[0] === 'e')
   move.extruding = (eToken !== undefined && Number(eToken.substring(1)) > 0) || props.cncMode //|| this.g1AsExtrusion //Treat as an extrusion in cnc mode

   const fToken = tokens.find((t) => t[0] === 'F' || t[0] === 'f')
   if (fToken !== undefined && move.extruding) {
      props.CurrentFeedRate = Number(fToken.substring(1))
   }
   move.feedRate = props.CurrentFeedRate

   // let cw = tokens.filter((t) => t === 'G2' || t === 'G02')

   let arcResult = {
      position: { x: props.currentPosition.x, y: props.currentPosition.y, z: props.currentPosition.z },
      points: [],
   }

   try {
      arcResult = doArc(
         tokens,
         props.currentPosition,
         !props.absolute,
         0.5,
         props.fixRadius,
         props.arcPlane,
         props.currentWorkplace,
      )
   } catch (ex) {
      console.error(`Arc Error`, ex)
   }
   let curPt = []
   props.currentPosition.toArray(curPt)

   arcResult.points.forEach((point, idx) => {
      const line = new Move(props, move.line)
      line.tool = props.currentTool.toolNumber
      line.lineNumber = move.lineNumber
      line.filePosition = move.filePosition
      line.feedRate = props.CurrentFeedRate
      line.color = props.slicer.getFeatureColor()
      line.isPerimeter = props.slicer.isPerimeter()
      line.isSupport = props.slicer.isSupport()

      line.start = [curPt[0], curPt[1], curPt[2]]
      line.end = [point.x, point.y, point.z]
      line.extruding = move.extruding
      curPt = line.end
      move.segments.push(line)
   })

   //Last point to currentposition
   props.currentPosition = Vector3.FromArray(curPt)
   props.totalRenderedSegments += move.segments.length

   return move
}
