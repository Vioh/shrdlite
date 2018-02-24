
/********************************************************************************
The goal of the Planner module is to take the interpetation(s) produced by the 
Interpreter module and to plan a sequence of actions for the robot to put the world 
into a state compatible with the user's command, i.e. to achieve what the user wanted.
********************************************************************************/
import {WorldState} from "./World";
import {Successor, Graph, SearchResult} from "./Graph";
import {aStarSearch} from "./AStarSearch";
import {ShrdliteResult, DNFFormula, Conjunction, Literal, SimpleObject} from "./Types";

/** 
 * Top-level driver for the Planner. 
 * It calls `makePlan` for each given interpretation generated by the Interpreter.
 * @param interpretations: List of possible interpretations.
 * @param world: The current state of the world.
 * @returns: List of planner results, which are the interpretation results augmented with plans. 
 *           Each plan is represented by a list of strings.
 *           If there's a planning error, it throws an error with a string description.
 */
export function plan(interpretations : ShrdliteResult[], world : WorldState) : ShrdliteResult[] {
    var errors : string[] = [];
    var plans : ShrdliteResult[] = [];
    var planner : Planner = new Planner(world);
    for (var result of interpretations) {
        try {
            var theplan : string[] = planner.makePlan(result.interpretation);
        } catch(err) {
            errors.push(err);
            continue;
        }
        result.plan = theplan;
        if (result.plan.length == 0) {
            result.plan.push("The interpretation is already true!");
        }
        plans.push(result);
    }
    if (plans.length == 0) {
        // merge all errors into one
        throw errors.join(" ; ");
    }
    return plans;
}

// ===============================================================================================
// ===============================================================================================
// ===============================================================================================

class ShrdliteGraph implements Graph<ShrdliteNode> {
    compareNodes(a : ShrdliteNode, b : ShrdliteNode) : number {
        return a.compareTo(b);
    }
    successors(current : ShrdliteNode) : Successor<ShrdliteNode>[] {
        let outputs : Successor<ShrdliteNode>[] = [];
        let actions = ["l","r","p","d"]; // left, right, pick, drop
        actions.forEach((action) => {
            let next : ShrdliteNode | null = current.neighbor(action);
            if(next) outputs.push({"action": action, "child": next, "cost": 1});
        });
        return outputs;
    }
}

// ===============================================================================================
// ===============================================================================================
// ===============================================================================================

class ShrdliteNode {
    public id : string;
    public state : WorldState;

    constructor(state : WorldState) {
        this.id = `${state.arm},${state.holding},${this.stringify(state.stacks)}`;
    }
    public toString() : string {
        return this.id;
    }
    public compareTo(other : ShrdliteNode) {
        return this.id.localeCompare(other.id);
    }
    public neighbor(action : string) : ShrdliteNode | null {
        let stacks = this.state.stacks;
        let holding = this.state.holding;
        let xpos = this.state.arm;
        let ypos = stacks[xpos].length - 1;

        if(action == 'l') {
            if(xpos == 0) return null;
            let newState : WorldState = this.clone(this.state);
            --newState.arm; // go left one step
            return new ShrdliteNode(newState);
        }
        if(action == 'r') {
            if(xpos == stacks.length-1) return null;
            let newState : WorldState = this.clone(this.state);
            ++newState.arm; // go right one step
            return new ShrdliteNode(newState);
        }
        if(action == 'p') {
            if(holding || ypos == -1) return null;
            let newState : WorldState = this.clone(this.state);
            newState.holding = newState.stacks[xpos][ypos];
            newState.stacks[xpos].splice(ypos, 1);
            return new ShrdliteNode(newState);
        }
        if(action == 'd') {
            let dest = (ypos == -1)? "floor" : stacks[xpos][ypos];
            if(!holding || this.isValidDrop(holding, dest)) return null;
            let newState = this.clone(this.state);
            if(!newState.holding) return null; // dummy check to pass compiler's type checker
            newState.stacks[xpos].push(newState.holding);
            newState.holding = null;
            return new ShrdliteNode(newState);
        }
        return null;
    }
    private stringify(stacks : string[][]) : string {
        let output : string[] = [];
        for(let stack of stacks)
            output.push(`[${stack.join(",")}]`);
        return `[${output.join(",")}]`;
    }
    private clone(state : WorldState) : WorldState {
        return {
            "stacks": JSON.parse(JSON.stringify(state.stacks)),
            "holding": state.holding,
            "arm": state.arm,
            "objects": state.objects,
            "examples": [], // examples are not needed for the planer
        };
    }
    private isValidDrop(obj1 : string, obj2 : string) : boolean {
        let floor : SimpleObject = new SimpleObject("floor", null, null);
        let a : SimpleObject = (obj1 == "floor")? floor : this.state.objects[obj1];
        let b : SimpleObject = (obj2 == "floor")? floor : this.state.objects[obj2];

        function memberOf(needle : string, haystack : string[]) : boolean {
            return haystack.indexOf(needle) > -1;
        }
        // Special case => anything can be dropped on the floor.
        if(b.form == "floor") return true;
        // Nothing can be dropped on a ball.
        if(b.form == "ball") return false;
        // A ball can't be dropped on anything else other than a box or the floor.
        if(a.form == "ball" && b.form != "box") return false;
        // A pyramid/plank/box cannot be dropped into a box of the same size.
        if(memberOf(a.form, ["pyramid","plank","box"]) && b.form == "box" && a.size == b.size) return false;
        // A large object cannot be dropped on a small object.
        if(a.size == "large" && b.size == "small") return false;

        if(a.form == "box" && memberOf(b.form, ["pyramid","brick"])) {
            // A small box cannot be dropped on a small brick/pyramid.
            if(a.size == "small" && b.size == "small") return false;
            // A large box cannot be dropped on a large pyramid.
            if(a.size == "large" && b.size == "large" && b.form == "pyramid") return false;
        }
        return true; 
    }
}

// ===============================================================================================
// ===============================================================================================
// ===============================================================================================

/** Returns the x-y coordinate of an object in the stacks. */
function coordinate(obj : string, state : WorldState) : {x : number, y : number} {
    for(let i : number = 0; i < state.stacks.length; ++i) {
        let j : number = state.stacks[i].indexOf(obj);
        if(j > -1) return {"x" : i, "y" : j};
    }
    return {"x" : -1, "y" : -1}; // this is for the floor
}

/** Returns true if the literal (binary relation) is true in the world state. */
function checkBinaryRelation(lit : Literal, state : WorldState) : boolean {
    let rel = lit.relation;
    let coorA = coordinate(lit.args[0], state); // coordinate of object A
    let coorB = coordinate(lit.args[1], state); // coordinate of object B
    
    // Case 1: A and B are on the same stack of objects.
    if(lit.args[1] == "floor" || coorA.x == coorB.x) {
        if(rel == "ontop"  && coorA.y == coorB.y + 1) return true;
        if(rel == "inside" && coorA.y == coorB.y + 1) return true;
        if(rel == "above"  && coorA.y > coorB.y) return true;
        if(rel == "under"  && coorA.y < coorB.y) return true;
    } 
    // Case 2: a and b are on 2 different stacks of objects
    else {
        if(rel == "beside"  && Math.abs(coorA.x - coorB.x) == 1) return true;
        if(rel == "leftof"  && coorA.x < coorB.x) return true;
        if(rel == "rightof" && coorA.x > coorB.x) return true;
    }
    return false;
}

/** Returns a specialized goal test for a ShrdliteNode */
function goalTest(interpretation : DNFFormula) : (node : ShrdliteNode) => boolean {
    return function(node : ShrdliteNode) : boolean {
        for(let conj of interpretation.conjuncts)
            if(isTrueConj(conj, node.state)) return true;
        return false;
    }
    function isTrueConj(conj : Conjunction, state : WorldState) : boolean {
        for(let lit of conj.literals)
            if(!isTrueLiteral(lit, state)) return false;
        return true;
    }
    function isTrueLiteral(lit : Literal, state : WorldState) : boolean {
        if(lit.args.length == 1) {
            if(lit.relation == "holding" && lit.args[0] == state.holding) return true;
        }
        else if(lit.args.length == 2) {
            return checkBinaryRelation(lit, state);
        }
        return false;
    }
}

// ===============================================================================================
// ===============================================================================================
// ===============================================================================================

/** Returns a specialized function to compute the heuristics for a ShrdliteNode */
function heuristics(intp : DNFFormula) : (node : ShrdliteNode) => number {
    return function(node : ShrdliteNode) : number {
        let heurs : number[] = intp.conjuncts.map((conj) => heurForConj(conj, node.state));
        return Math.min(...heurs);
    }
    function heurForConj(conj : Conjunction, state : WorldState) : number {
        let heurs : number[] = conj.literals.map((lit) => heurForLit(lit, state));
        return Math.max(...heurs);
    }
    function heurForLit(lit : Literal, state : WorldState) : number {
        let numOfOper = 4;
        if(lit.relation == "holding") {
            if(state.holding == lit.args[0]) return 0;
            let coor = coordinate(lit.args[0], state);
            let numOntop = state.stacks[coor.x].length - coor.y - 1;
            return numOfOper * numOntop;
        }
        if(checkBinaryRelation(lit, state)) return 0; // goal state
        let coorA = coordinate(lit.args[0], state);
        let coorB = coordinate(lit.args[1], state);
        let numOntopA = state.stacks[coorA.x].length - coorA.y - 1;
        let numOntopB = state.stacks[coorA.x].length - coorA.y - 1;
        if(coorA.x != coorB.x) {
            if(lit.args[1] == "floor") return numOfOper * numOntopA;
            return numOfOper * (numOntopA + numOntopB);
        } else {
            return numOfOper * Math.min(numOntopA, numOntopB);
        }
    }
}

// ===============================================================================================
// ===============================================================================================
// ===============================================================================================

class Planner {
    constructor(private world : WorldState) {}
    /** 
     * The core planner method.
     * @param interpretation: The logical interpretation of the user's desired goal. 
     * @returns: A plan, represented by a list of strings.
     *           If there's a planning error, it throws an error with a string description.
     */
    makePlan(intp : DNFFormula) : string[] {
        let start : ShrdliteNode = new ShrdliteNode(this.world);
        let result = aStarSearch(new ShrdliteGraph(), start, goalTest(intp), heuristics(intp), 10);
        if(result.status == "timeout")
            throw `TIMEOUT! Visited ${result.visited} nodes`;
        if(result.status == "failure")
            throw `No path exists from start to goal`;
        return result.path.map((incomingEdge) => incomingEdge.action);
    }
}

// TODO: Throw errors in plannner at appropriae places!
// TODO: Test timeout "medium" "put the brick that is to the left of a pyramid in a box"
// leftof, rightof, inside, ontop, under, beside, above, HOLDING