import { react } from "babel-types";
import * as t from "babel-types";

const referenceVisitor = {
  // This visitor looks for bindings to establish a topmost scope for hoisting.
  ReferencedIdentifier(path, state) {
    // Don't hoist regular JSX identifiers ('div', 'span', etc).
    // We do have to consider member expressions for hoisting (e.g. `this.component`)
    if (
      path.isJSXIdentifier() &&
      react.isCompatTag(path.node.name) &&
      !path.parentPath.isJSXMemberExpression()
    ) {
      return;
    }

    // If the identifier refers to `this`, we need to break on the closest non-arrow scope.
    if (path.node.name === "this") {
      let scope = path.scope;
      do {
        if (scope.path.isFunction() && !scope.path.isArrowFunctionExpression())
          break;
      } while ((scope = scope.parent));
      if (scope) state.breakOnScopePaths.push(scope.path);
    }

    // direct references that we need to track to hoist this to the highest scope we can
    const binding = path.scope.getBinding(path.node.name);
    if (!binding) return;

    // this binding isn't accessible from the parent scope so we can safely ignore it
    // eg. it's in a closure etc
    if (binding !== state.scope.getBinding(path.node.name)) return;

    state.bindings[path.node.name] = binding;
  },
};

export default class PathHoister {
  constructor(path, scope) {
    // Storage for scopes we can't hoist above.
    this.breakOnScopePaths = [];
    // Storage for bindings that may affect what path we can hoist to.
    this.bindings = {};
    // Storage for eligible scopes.
    this.scopes = [];
    // Our original scope and path.
    this.scope = scope;
    this.path = path;
    // By default, we attach as far up as we can; but if we're trying
    // to avoid referencing a binding, we may have to go after.
    this.attachAfter = false;
  }

  // A scope is compatible if all required bindings are reachable.
  isCompatibleScope(scope) {
    for (const key in this.bindings) {
      const binding = this.bindings[key];
      if (!scope.bindingIdentifierEquals(key, binding.identifier)) {
        return false;
      }
    }

    return true;
  }

  // Look through all scopes and push compatible ones.
  getCompatibleScopes() {
    let scope = this.path.scope;
    do {
      if (this.isCompatibleScope(scope)) {
        this.scopes.push(scope);
      } else {
        break;
      }

      // deopt: These scopes are set in the visitor on const violations
      if (this.breakOnScopePaths.indexOf(scope.path) >= 0) {
        break;
      }
    } while ((scope = scope.parent));
  }

  getAttachmentPath() {
    let path = this._getAttachmentPath();
    if (!path) return;

    let targetScope = path.scope;

    // don't allow paths that have their own lexical environments to pollute
    if (targetScope.path === path) {
      targetScope = path.scope.parent;
    }

    // avoid hoisting to a scope that contains bindings that are executed after our attachment path
    if (targetScope.path.isProgram() || targetScope.path.isFunction()) {
      for (const name in this.bindings) {
        // check binding is a direct child of this paths scope
        if (!targetScope.hasOwnBinding(name)) continue;

        const binding = this.bindings[name];

        // allow parameter references
        if (binding.kind === "param") continue;

        // if this binding appears after our attachment point, then we move after it.
        if (this.getAttachmentParentForPath(binding.path).key > path.key) {
          this.attachAfter = true;
          path = binding.path;

          // We also move past any constant violations.
          for (const violationPath of (binding.constantViolations: Array)) {
            if (this.getAttachmentParentForPath(violationPath).key > path.key) {
              path = violationPath;
            }
          }
        }
      }
    }

    return path;
  }

  _getAttachmentPath() {
    const scopes = this.scopes;

    const scope = scopes.pop();
    // deopt: no compatible scopes
    if (!scope) return;

    if (scope.path.isFunction()) {
      if (this.hasOwnParamBindings(scope)) {
        // deopt: should ignore this scope since it's ourselves
        if (this.scope === scope) return;

        // needs to be attached to the body
        return scope.path.get("body").get("body")[0];
      } else {
        // doesn't need to be be attached to this scope
        return this.getNextScopeAttachmentParent();
      }
    } else if (scope.path.isProgram()) {
      return this.getNextScopeAttachmentParent();
    }
  }

  getNextScopeAttachmentParent() {
    const scope = this.scopes.pop();
    if (scope) return this.getAttachmentParentForPath(scope.path);
  }

  // Find an attachment for this path.
  getAttachmentParentForPath(path) {
    do {
      if (
        // Beginning of the scope
        !path.parentPath ||
        // Has siblings and is a statement
        (Array.isArray(path.container) && path.isStatement()) ||
        // Is part of multiple var declarations
        (path.isVariableDeclarator() &&
          path.parentPath.node !== null &&
          path.parentPath.node.declarations.length > 1)
      ) {
        return path;
      }
    } while ((path = path.parentPath));
  }

  // Returns true if a scope has param bindings.
  hasOwnParamBindings(scope) {
    for (const name in this.bindings) {
      if (!scope.hasOwnBinding(name)) continue;

      const binding = this.bindings[name];
      // Ensure constant; without it we could place behind a reassignment
      if (binding.kind === "param" && binding.constant) return true;
    }
    return false;
  }

  run() {
    const node = this.path.node;
    if (node._hoisted) return;
    node._hoisted = true;

    this.path.traverse(referenceVisitor, this);

    this.getCompatibleScopes();

    const attachTo = this.getAttachmentPath();
    if (!attachTo) return;

    // don't bother hoisting to the same function as this will cause multiple branches to be
    // evaluated more than once leading to a bad optimisation
    if (attachTo.getFunctionParent() === this.path.getFunctionParent()) return;

    // generate declaration and insert it to our point
    let uid = attachTo.scope.generateUidIdentifier("ref");
    const declarator = t.variableDeclarator(uid, this.path.node);

    const insertFn = this.attachAfter ? "insertAfter" : "insertBefore";
    attachTo[insertFn]([
      attachTo.isVariableDeclarator()
        ? declarator
        : t.variableDeclaration("var", [declarator]),
    ]);

    const parent = this.path.parentPath;
    if (parent.isJSXElement() && this.path.container === parent.node.children) {
      // turning the `span` in `<div><span /></div>` to an expression so we need to wrap it with
      // an expression container
      uid = t.JSXExpressionContainer(uid);
    }

    this.path.replaceWith(uid);
  }
}
