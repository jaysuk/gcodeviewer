import { Move, Base } from '../GCodeLines'
import Props from '../processorproperties'

//Reminder Add G53 check

const tokenList = /(?=[GXYZEFUVAB])/

export default function (props: Props, line: string): Base {
   const move = new Move(props, line)
   move.tool = props.currentTool.toolNumber
   props.currentPosition.toArray(move.start)

   const tokens = line.split(tokenList)

   let forceAbsolute = false

   if (props.zBelt) tokens.reverse()

   for (let idx = 0; idx < tokens.length; idx++) {
      const token = tokens[idx]
      const firstChar = token[0].toUpperCase()
      switch (firstChar) {
         case 'G': {
            const upperToken = token.toUpperCase()
            if (upperToken == 'G53') forceAbsolute = true
            if (upperToken == 'G1' || upperToken == 'G01') {
               //move.extruding = true
               // move.color already comes from the slicer feature (set in Move's constructor) -
               // matches the WASM parser, which also uses feature color rather than tool color
               // for render mode 0. Tool color has its own render mode (1).
               move.extruding = props.cncMode
            }
            break
         }
         case 'X':
            if (props.zBelt) {
               props.currentPosition.x = Number(token.substring(1))
            } else {
               props.currentPosition.x =
                  props.absolute || forceAbsolute
                     ? Number(token.substring(1)) + props.currentWorkplace.x
                     : props.currentPosition.x + Number(token.substring(1))
            }
            break
         case 'Y':
            if (props.zBelt) {
               props.currentPosition.y = Number(token.substring(1)) * props.hyp
               props.currentPosition.z = props.currentZ + props.currentPosition.y * props.adj
            } else {
               props.currentPosition.z =
                  props.absolute || forceAbsolute
                     ? Number(token.substring(1)) + props.currentWorkplace.y
                     : props.currentPosition.z + Number(token.substring(1))
            }
            break
         case 'Z':
            if (props.zBelt) {
               props.currentZ = -Number(token.substring(1))
               props.currentPosition.z = props.currentZ + props.currentPosition.y * props.adj
            } else {
               props.currentPosition.y =
                  props.absolute || forceAbsolute
                     ? Number(token.substring(1)) + props.currentWorkplace.z
                     : props.currentPosition.y + Number(token.substring(1))
            }
            break
         case 'E':
            if (Number(token.substring(1)) > 0) {
               move.extruding = true
            }
            break
         case 'F':
            if (move.extruding) props.CurrentFeedRate = Number(token.substring(1))
            break
      }
   }

   if (!move.extruding) {
      move.lineType = 'T'
      move.tool = 255
   }

   move.feedRate = props.CurrentFeedRate
   props.currentPosition.toArray(move.end)
   props.updateHeight(props.currentPosition.y)

   return move
}
