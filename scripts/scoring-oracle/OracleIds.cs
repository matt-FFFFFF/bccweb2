using System.Security.Cryptography;
using System.Text;

namespace ScoringOracle;

public static class OracleIds
{
    public static string Round(int id) => DeterministicGuid($"round:{id}");
    public static string Site(int id) => DeterministicGuid($"site:{id}");
    public static string Club(int id) => DeterministicGuid($"club:{id}");
    public static string Team(int id) => DeterministicGuid($"team:{id}");
    public static string Pilot(int id) => DeterministicGuid($"pilot:{id}");
    public static string Flight(int id) => DeterministicGuid($"flight:{id}");

    private static string DeterministicGuid(string value)
    {
        byte[] bytes = MD5.HashData(Encoding.UTF8.GetBytes(value));
        bytes[6] = (byte)((bytes[6] & 0x0F) | 0x40);
        bytes[8] = (byte)((bytes[8] & 0x3F) | 0x80);
        return new Guid(bytes).ToString();
    }
}
