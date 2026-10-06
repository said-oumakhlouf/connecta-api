"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
exports.__esModule = true;
exports.ProductsModule = void 0;
var common_1 = require("@nestjs/common");
var prisma_module_js_1 = require("../prisma/prisma.module.js");
var products_controller_js_1 = require("./products.controller.js");
var products_service_js_1 = require("./products.service.js");
var ProductsModule = /** @class */ (function () {
    function ProductsModule() {
    }
    ProductsModule = __decorate([
        common_1.Module({
            imports: [prisma_module_js_1.PrismaModule],
            controllers: [products_controller_js_1.ProductsController],
            providers: [products_service_js_1.ProductsService]
        })
    ], ProductsModule);
    return ProductsModule;
}());
exports.ProductsModule = ProductsModule;
