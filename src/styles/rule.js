import {match} from 'match-feature';
import log from 'loglevel';

export const whiteList = ['filter', 'style', 'data', 'properties'];

export let ruleCache = {};

function cacheKey (rules) {
    return rules.map(r => r.id).join('/');
}

export function mergeTrees(matchingTrees, context) {
    let style = {},
        order = [],
        order_styles = [];

    // Visible by default
    style.visible = true;

    // Find deepest tree
    let len = 0;
    matchingTrees.map(x => x.length).forEach(x => len = Math.max(len, x));

    // Iterate trees in parallel
    for (let x = 0; x < len; x++) {
        let styles = matchingTrees.map(tree => tree[x]);

        // Property-specific logic
        for (let i=0; i < styles.length; i++) {
            if (!styles[i]) {
                continue;
            }

            // Collect unique orders (don't add the order multiple times for the smae style rule)
            if (styles[i].order !== undefined) {
                if (order_styles.indexOf(styles[i]) === -1) {
                    order.push(styles[i].order);
                    order_styles.push(styles[i]);
                }
            }
        }

        // Merge remaining style objects
        mergeObjects(style, ...styles);
    }

    // Short-circuit if not visible
    if (style.visible === false) {
        return null;
    }

    // Sum all orders
    if (order.length > 0) {
        // Order can be cached if it is only a single value
        if (order.length === 1 && typeof order[0] === 'number') {
            order = order[0];
        }
        // Or if there are no function dependencies
        else if (!order.some(v => typeof v === 'function')) {
            order = calculateOrder(order, context);
        }
        style.order = order;
    }

    return style;
}


class Rule {

    constructor(name, parent, style, filter, properties) {
        this.id = Rule.id++;
        this.name = name;
        this.style = style;
        this.filter = filter;
        this.properties = properties;
        this.parent = parent;

        // Add properties to style
        if (this.style && this.properties) {
            this.style.properties = this.properties;
        }

        this.buildFilter();
        this.buildStyle();
    }

    buildStyle() {
        this.calculatedStyle = calculateStyle(this);
    }

    buildFilter() {
        var type = typeof this.filter;
        if (type === 'object') {
            this.filter = match(this.filter);
        }
    }

    toJSON() {
        return {
            name: this.name,
            sytle: this.style
        };
    }

}

Rule.id = 0;


export class RuleLeaf extends Rule {
    constructor({name, parent, style, filter, properties}) {
        super(name, parent, style, filter, properties);
    }

}

export class RuleTree extends Rule {
    constructor({name, parent, style, rules, filter, properties}) {
        super(name, parent, style, filter, properties);
        this.rules = rules || [];
    }

    addRule(rule) {
        this.rules.push(rule);
    }

    findMatchingRules(context) {
        let rules  = [];
        //TODO, should this function take a RuleTree
        matchFeature(context, [this], rules);

        if (rules.length > 0) {

            let key = cacheKey(rules);
            if (!ruleCache[key]) {
                ruleCache[key] = mergeTrees(rules.map(x => x && x.calculatedStyle), context);
            }
            return ruleCache[key];
        }
    }

}

function isWhiteListed(key) {
    return whiteList.indexOf(key) > -1;
}

function isEmpty(obj) {
    return Object.keys(obj).length === 0;
}

export function walkUp(rule, cb) {

    if (rule.parent) {
        walkUp(rule.parent, cb);
    }

    cb(rule);
}

export function walkDown(rule, cb) {

    if (rule.rules) {
        rule.rules.forEach((r) => {
            walkDown(r, cb);
        });
    }

    cb(rule);
}

export function groupProps(obj) {
    let whiteListed = {}, nonWhiteListed = {};

    for (let key in obj) {
        if (isWhiteListed(key)) {
            whiteListed[key] = obj[key];
        } else {
            nonWhiteListed[key] = obj[key];
        }
    }
    return [whiteListed, nonWhiteListed];
}

export function calculateStyle(rule) {

    let styles  = [];

    if (rule.parent) {
        let cs = rule.parent.calculatedStyle || [];
        styles.push(...cs);
    }

    styles.push(rule.style);
    return styles;
}

export function mergeObjects(newObj, ...sources) {

    for (let source of sources) {
        if (!source) {
            continue;
        }
        for (let key in source) {
            let value = source[key];
            if (typeof value === 'object' && !Array.isArray(value)) {
                newObj[key] = mergeObjects(newObj[key] || {}, value);
            } else {
                newObj[key] = value;
            }
        }

    }
    return newObj;
}

export function calculateOrder(orders, context = null, defaultOrder = 0) {
    let sum = defaultOrder;

    for (let order of orders) {
        if (typeof order === 'function') {
            order = order(context);
        } else {
            order = parseFloat(order);
        }

        if (!order || isNaN(order)) {
            continue;
        }
        sum += order;
    }
    return sum;
}


export function parseRuleTree(name, rule, parent) {

    let properties = {name, parent};
    let [whiteListed, nonWhiteListed] = groupProps(rule);
    let empty = isEmpty(nonWhiteListed);
    let Create;

    if (empty && parent != null) {
        Create = RuleLeaf;
    } else {
        Create = RuleTree;
    }

    let r = new Create(Object.assign(properties, whiteListed));

    if (parent) {
        parent.addRule(r);
    }

    if (!empty) {
        for (let key in nonWhiteListed) {
            let property = nonWhiteListed[key];
            if (typeof property === 'object') {
                parseRuleTree(key, property, r);
            } else {
                log.warn('Rule property must be an object: ', name, rule, property);
            }
        }

    }

    return r;
}


export function parseRules(rules) {
    let ruleTrees = {};

    for (let key in rules) {
        let rule = rules[key];
        ruleTrees[key] = parseRuleTree(key, rule);
    }

    return ruleTrees;
}


function doesMatch(filter, context) {
    return ((typeof filter === 'function' && filter(context)) || (filter == null));
}

export function matchFeature(context, rules, collectedRules) {
    let matched = false;
    let childMatched = false;

    if (rules.length === 0) { return; }

    for (let r=0; r < rules.length; r++) {
        let current = rules[r];
        context.properties = current.properties;

        if (current instanceof RuleLeaf) {

            if (doesMatch(current.filter, context)) {
                matched = true;
                collectedRules.push(current);
            }

        } else if (current instanceof RuleTree) {
            if (doesMatch(current.filter, context)) {
                matched = true;

                childMatched = matchFeature(
                    context,
                    current.rules,
                    collectedRules
                );

                if (!childMatched) {
                    collectedRules.push(current);
                }
            }
        }

        context.properties = null;
    }

    return matched;
}
