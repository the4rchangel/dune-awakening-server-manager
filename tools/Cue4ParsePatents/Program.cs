using CUE4Parse.FileProvider;
using CUE4Parse.UE4.Assets.Exports.Engine;
using CUE4Parse.UE4.Versions;
using CUE4Parse.Utils;
using System.Text.Json;
using System.Text.RegularExpressions;

const string defaultPaksDir =
    "/mnt/c/Program Files (x86)/Steam/steamapps/common/DuneAwakening/DuneSandbox/Content/Paks";

var paksDir = args.Length > 0 ? args[0] : defaultPaksDir;
var outDir = args.Length > 1 ? args[1] : Directory.GetCurrentDirectory();

if (!Directory.Exists(paksDir))
{
    Console.Error.WriteLine($"Paks directory not found: {paksDir}");
    return 1;
}

Console.WriteLine($"Scanning: {paksDir}");

var pathComparer = StringComparer.OrdinalIgnoreCase;
var provider = new DefaultFileProvider(
    paksDir,
    SearchOption.TopDirectoryOnly,
    versions: new VersionContainer(EGame.GAME_DuneAwakening),
    pathComparer: pathComparer);

provider.Initialize();
var mounted = provider.Mount();
Console.WriteLine($"Mounted {mounted} archives; {provider.Files.Count:N0} files");

var allPaths = provider.Files.Keys.ToList();

var catalogPath = Path.GetFullPath(Path.Combine(outDir, "..", "..", "public", "data", "item-catalog.json"));
var catalogIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
if (File.Exists(catalogPath))
{
    var json = File.ReadAllText(catalogPath);
    foreach (Match m in Regex.Matches(json, "\"([^\"]+)\"\\s*:\\s*\\{"))
        catalogIds.Add(m.Groups[1].Value);
    Console.WriteLine($"Loaded {catalogIds.Count} catalog IDs");
}

// Inventory template IDs for vehicle modules: SandbikeChassis_5, TreadwheelEngine_4, etc.
var modulePattern = new Regex(
    @"^(?<prefix>Sandbike|Buggy|Treadwheel|OrnithopterTransport|OrnithopterLight|OrnithopterMedium|AssaultOrnithopter|CarrierOrnithopter|Sandcrawler|Groundcar|OrnithopterHeavy)(?<part>(?:Unique_[A-Za-z0-9_]+|[A-Za-z_]+))_(?<tier>\d+)$",
    RegexOptions.Compiled | RegexOptions.IgnoreCase);

var moduleIds = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

foreach (var path in allPaths)
{
    var baseName = Path.GetFileNameWithoutExtension(path);
    if (string.IsNullOrEmpty(baseName)) continue;

    if (modulePattern.IsMatch(baseName))
    {
        moduleIds.TryAdd(baseName, path);
        continue;
    }

    if (baseName.StartsWith("DA_REC_", StringComparison.OrdinalIgnoreCase))
    {
        var embedded = baseName["DA_REC_".Length..];
        if (modulePattern.IsMatch(embedded))
            moduleIds.TryAdd(embedded, path);
    }
}

// Also collect item-ish paths under /Items/ for manual review
var itemPaths = allPaths
    .Where(p => p.Contains("/Items/", StringComparison.OrdinalIgnoreCase) &&
                (p.Contains("Treadwheel", StringComparison.OrdinalIgnoreCase) ||
                 p.Contains("OrnithopterTransport", StringComparison.OrdinalIgnoreCase) ||
                 p.Contains("CargoContainer", StringComparison.OrdinalIgnoreCase) ||
                 p.Contains("Sandcrawler", StringComparison.OrdinalIgnoreCase)))
    .OrderBy(p => p, StringComparer.OrdinalIgnoreCase)
    .ToList();

Directory.CreateDirectory(outDir);
var moduleOut = Path.Combine(outDir, "vehicle-module-ids.txt");
File.WriteAllLines(moduleOut, moduleIds.Keys.OrderBy(x => x, StringComparer.OrdinalIgnoreCase));
var moduleMissing = moduleIds.Keys.Where(id => !catalogIds.Contains(id)).OrderBy(x => x).ToList();
var moduleMissingOut = Path.Combine(outDir, "missing-vehicle-module-ids.txt");
File.WriteAllLines(moduleMissingOut, moduleMissing);
File.WriteAllLines(Path.Combine(outDir, "item-path-hints.txt"), itemPaths);

Console.WriteLine();
Console.WriteLine($"=== Vehicle module template IDs: {moduleIds.Count} ({moduleMissing.Count} missing from catalog) ===");
foreach (var prefix in new[] { "Treadwheel", "OrnithopterTransport", "CarrierOrnithopter", "Sandcrawler", "Groundcar" })
{
    var ids = moduleIds.Keys.Where(k => k.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)).OrderBy(x => x).ToList();
    if (ids.Count == 0) continue;
    Console.WriteLine();
    Console.WriteLine($"-- {prefix} ({ids.Count}) --");
    foreach (var id in ids)
    {
        var flag = catalogIds.Contains(id) ? "OK" : "MISSING";
        Console.WriteLine($"  [{flag}] {id}");
    }
}

Console.WriteLine();
Console.WriteLine($"Wrote {moduleOut}");
Console.WriteLine($"Wrote {moduleMissingOut}");
Console.WriteLine($"Wrote {Path.Combine(outDir, "item-path-hints.txt")} ({itemPaths.Count} paths)");

// Broader item-source discovery for future catalog patches
var sourceHints = new[] { "/Items/", "ItemTemplate", "ItemDefinition", "ItemData", "DataTable", "DT_", "InventoryItem", "CargoContainer", "StorageContainer", "PlacableSet", "Patent" };
foreach (var hint in sourceHints)
{
    var count = allPaths.Count(p => p.Contains(hint, StringComparison.OrdinalIgnoreCase));
    if (count > 0) Console.WriteLine($"  paths[{hint}]: {count}");
}

var recPattern = new Regex(@"^DA_REC_(.+)$", RegexOptions.Compiled | RegexOptions.IgnoreCase);
var recIds = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
foreach (var path in allPaths)
{
    var baseName = Path.GetFileNameWithoutExtension(path);
    if (baseName == null) continue;
    var m = recPattern.Match(baseName);
    if (m.Success) recIds.Add(m.Groups[1].Value);
}
var recOut = Path.Combine(outDir, "da-rec-template-ids.txt");
File.WriteAllLines(recOut, recIds);
Console.WriteLine($"DA_REC-derived template IDs: {recIds.Count} -> {recOut}");

var registryPaths = allPaths
    .Where(p => Regex.IsMatch(p, @"(ItemTemplates|ItemDefinitions|ItemRegistry|MasterItem|AllItems|ItemCatalog|DT_.*Item|ItemTable)", RegexOptions.IgnoreCase))
    .OrderBy(p => p, StringComparer.OrdinalIgnoreCase)
    .ToList();
var registryOut = Path.Combine(outDir, "item-registry-paths.txt");
File.WriteAllLines(registryOut, registryPaths);
Console.WriteLine($"Item registry candidate paths: {registryPaths.Count} -> {registryOut}");

var cargoPaths = allPaths
    .Where(p => p.Contains("Cargo", StringComparison.OrdinalIgnoreCase) &&
                (p.Contains("Ornithopter", StringComparison.OrdinalIgnoreCase) ||
                 p.Contains("Transport", StringComparison.OrdinalIgnoreCase) ||
                 p.Contains("Container", StringComparison.OrdinalIgnoreCase) ||
                 p.Contains("Storage", StringComparison.OrdinalIgnoreCase)))
    .OrderBy(p => p, StringComparer.OrdinalIgnoreCase)
    .ToList();
var cargoOut = Path.Combine(outDir, "cargo-container-paths.txt");
File.WriteAllLines(cargoOut, cargoPaths);
Console.WriteLine($"Cargo/container ornithopter paths: {cargoPaths.Count} -> {cargoOut}");
foreach (var p in cargoPaths.Where(p => p.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase)).Take(15))
    Console.WriteLine("  " + p);

var baseItemTables = new[]
{
    "DuneSandbox/Content/Dune/Systems/Items/BaseItems/DT_BaseItems_Vehicles",
    "DuneSandbox/Content/Dune/Systems/Items/BaseItems/DT_BaseItems_BuildingSets",
    "DuneSandbox/Content/Dune/Systems/Items/BaseItems/DT_BaseItems_Placeables",
    "DuneSandbox/Content/Dune/Systems/Items/BaseItems/DT_BaseItems_Resources",
    "DuneSandbox/Content/Dune/Systems/Items/CDT_BaseItems",
    "DuneSandbox/Content/Dune/GUI/Widgets/Menus/Gameplay/AdminPanel/Items/DT_Admin_QuickItems_Presets",
};

Console.WriteLine();
Console.WriteLine("=== DT_BaseItems row keys ===");
foreach (var tablePath in baseItemTables)
{
    var tableName = tablePath.SubstringAfterLast('/');
    try
    {
        var table = provider.SafeLoadPackageObject<UDataTable>(tablePath, tableName);
        if (table?.RowMap == null)
        {
            Console.WriteLine($"  {tableName}: failed to load");
            continue;
        }

        var keys = table.RowMap.Keys.Select(k => k.Text).OrderBy(x => x, StringComparer.OrdinalIgnoreCase).ToList();
        var tableOut = Path.Combine(outDir, $"{tableName}-rows.txt");
        File.WriteAllLines(tableOut, keys);
        Console.WriteLine($"  {tableName}: {keys.Count} rows -> {tableOut}");

        var cargo = keys.Where(k => k.Contains("Cargo", StringComparison.OrdinalIgnoreCase) ||
                                    k.Contains("Container", StringComparison.OrdinalIgnoreCase) ||
                                    k.Contains("Treadwheel", StringComparison.OrdinalIgnoreCase) ||
                                    k.Contains("Patent", StringComparison.OrdinalIgnoreCase)).ToList();
        foreach (var k in cargo.Take(20)) Console.WriteLine($"    {k}");
    }
    catch (Exception ex)
    {
        Console.WriteLine($"  {tableName}: {ex.Message}");
    }
}

// Fallback: extract printable template-id-like strings from key table uexp blobs
Console.WriteLine();
Console.WriteLine("=== UEXP string fallback (template ID candidates) ===");
var idFromBytes = new Regex(@"\b[A-Z][A-Za-z0-9_]{2,80}\b", RegexOptions.Compiled);
foreach (var tablePath in baseItemTables)
{
    var uexpPath = tablePath + ".uexp";
    if (!provider.Files.TryGetValue(uexpPath, out var file)) continue;
    try
    {
        var bytes = file.Read();
        var text = System.Text.Encoding.ASCII.GetString(bytes);
        var ids = idFromBytes.Matches(text)
            .Select(m => m.Value)
            .Where(v => v.Contains('_') && !v.StartsWith("DA_", StringComparison.Ordinal) &&
                        !v.EndsWith("Placeable", StringComparison.OrdinalIgnoreCase) &&
                        char.IsUpper(v[0]))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
            .ToList();
        var tableName = tablePath.SubstringAfterLast('/');
        var outPath = Path.Combine(outDir, $"{tableName}-uexp-ids.txt");
        File.WriteAllLines(outPath, ids);
        Console.WriteLine($"  {tableName}: {ids.Count} id-like strings -> {outPath}");
        foreach (var id in ids.Where(i => i.Contains("Cargo", StringComparison.OrdinalIgnoreCase) ||
                                          i.Contains("Container", StringComparison.OrdinalIgnoreCase) ||
                                          i.Contains("Treadwheel", StringComparison.OrdinalIgnoreCase) ||
                                          i.Contains("Patent", StringComparison.OrdinalIgnoreCase)).Take(12))
            Console.WriteLine($"    {id}");
    }
    catch (Exception ex)
    {
        Console.WriteLine($"  {tablePath}: uexp read failed: {ex.Message}");
    }
}

static string TechCategory(string id)
{
    if (id.StartsWith("DA_GRP_", StringComparison.OrdinalIgnoreCase)) return "Group";
    if (id.StartsWith("DA_REC_", StringComparison.OrdinalIgnoreCase)) return "Recipe";
    if (id.StartsWith("RCP_", StringComparison.OrdinalIgnoreCase)) return "Recipe";
    if (id.StartsWith("BLD_", StringComparison.OrdinalIgnoreCase)) return "Building";
    return "Other";
}

static bool IsTechTreeNodeId(string name) =>
    name.StartsWith("DA_GRP_", StringComparison.OrdinalIgnoreCase) ||
    name.StartsWith("DA_REC_", StringComparison.OrdinalIgnoreCase) ||
    name.StartsWith("RCP_", StringComparison.OrdinalIgnoreCase) ||
    name.StartsWith("BLD_", StringComparison.OrdinalIgnoreCase);

var techNodeIds = allPaths
    .Where(p => p.Contains("/TechKnowledge/", StringComparison.OrdinalIgnoreCase) &&
                p.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase))
    .Select(p => Path.GetFileNameWithoutExtension(p)!)
    .Where(IsTechTreeNodeId)
    .Concat(allPaths
        .Where(p => p.EndsWith(".uasset", StringComparison.OrdinalIgnoreCase))
        .Select(p => Path.GetFileNameWithoutExtension(p)!)
        .Where(n => n.StartsWith("RCP_", StringComparison.OrdinalIgnoreCase) ||
                    n.StartsWith("BLD_", StringComparison.OrdinalIgnoreCase)))
    .Distinct(StringComparer.OrdinalIgnoreCase)
    .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
    .ToList();

var techOut = Path.Combine(outDir, "tech-tree-node-ids.txt");
File.WriteAllLines(techOut, techNodeIds);

var techCatalogPath = Path.GetFullPath(Path.Combine(outDir, "..", "..", "public", "data", "tech-recipe-catalog.json"));
var recipes = new Dictionary<string, object>();
foreach (var id in techNodeIds)
    recipes[id] = new { category = TechCategory(id) };

Directory.CreateDirectory(Path.GetDirectoryName(techCatalogPath)!);
File.WriteAllText(
    techCatalogPath,
    JsonSerializer.Serialize(
        new { total = techNodeIds.Count, recipes },
        new JsonSerializerOptions { WriteIndented = true }));

Console.WriteLine();
Console.WriteLine($"=== Tech tree node IDs: {techNodeIds.Count} ===");
foreach (var prefix in new[] { "DA_GRP_", "DA_REC_", "RCP_", "BLD_" })
{
    var n = techNodeIds.Count(id => id.StartsWith(prefix, StringComparison.OrdinalIgnoreCase));
    if (n > 0) Console.WriteLine($"  {prefix}: {n}");
}
Console.WriteLine($"Wrote {techOut}");
Console.WriteLine($"Wrote {techCatalogPath}");

return 0;
